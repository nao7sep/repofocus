import type { GitRepository } from './gitApi';
import {
  mapVisibilityCommandsInOrder,
  VisibilityProbeInterruptedError,
  type VisibilityProbeTimings,
} from './visibilityBaseline';
import {
  discoverVisibilityCommands,
  OtherScmProvidersError,
  VisibilityCompatibilityError,
} from './visibilityCommandResolver';
import type { VisibilityReconciler } from './visibilityReconciler';
import {
  HostOperationTimeoutError,
  NonOverlappingHostOperation,
} from './hostOperation';

export interface VisibilityInitialization {
  readonly repositoryCount: number;
  readonly revision: number;
}

export type VisibilityUnavailableReason =
  | 'awaiting-native-commands'
  | 'loading-repositories'
  | 'other-scm-providers';

export interface VisibilityMappingCoordinatorOptions {
  readonly filteringRequested: () => boolean;
  readonly getCommands: () => Promise<readonly string[]>;
  readonly getRepositories: () => readonly GitRepository[];
  readonly topologyReady: () => boolean;
  readonly resetNativeVisibility: () => Promise<void>;
  readonly reconciler: VisibilityReconciler;
  readonly onInitialized?: (event: VisibilityInitialization) => void;
  readonly onUnavailable?: (reason: VisibilityUnavailableReason) => void;
  readonly probeTimings?: VisibilityProbeTimings;
  readonly commandRetryAttempts?: number;
  readonly commandRetryMilliseconds?: number;
  readonly commandRetryTimeoutMilliseconds?: number;
  readonly commandUnavailableRetryMilliseconds?: number;
  readonly topologySettleMilliseconds?: number;
}

const minimumRepositoryCount = 2;
export const DEFAULT_COMMAND_REGISTRATION_TIMEOUT_MILLISECONDS = 5_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export class VisibilityMappingCoordinator {
  private revision = 0;
  private requestedAt = 0;
  private run: Promise<void> | undefined;
  private disposed = false;
  private hasBaseline = false;
  private unavailableReason: VisibilityUnavailableReason | undefined;
  private reportedReason: VisibilityUnavailableReason | undefined;
  private commandRegistrationRetry: ReturnType<typeof setTimeout> | undefined;
  private filteringRequested: boolean;
  private readonly commandEnumeration = new NonOverlappingHostOperation<readonly string[]>();

  constructor(private readonly options: VisibilityMappingCoordinatorOptions) {
    this.filteringRequested = options.filteringRequested();
  }

  get baselineEstablished(): boolean {
    return this.hasBaseline;
  }

  get mappingState(): 'mapped' | 'incompatible' | VisibilityUnavailableReason | 'idle' {
    if (!this.options.reconciler.compatible) return 'incompatible';
    if (this.hasBaseline) return 'mapped';
    return this.unavailableReason ?? 'idle';
  }

  requestRefresh(): void {
    if (this.disposed || !this.options.reconciler.compatible) return;
    if (this.commandRegistrationRetry) {
      clearTimeout(this.commandRegistrationRetry);
      this.commandRegistrationRetry = undefined;
    }
    this.revision += 1;
    this.requestedAt = Date.now();
    this.hasBaseline = false;
    void this.options.reconciler.pause();
    this.startDrain();
  }

  retryIfUnavailable(): void {
    if (this.mappingState !== 'mapped') this.requestRefresh();
  }

  async updateFiltering(enabled = this.options.filteringRequested()): Promise<void> {
    this.filteringRequested = enabled;
    const shouldFilter = this.shouldFilter();
    if (!shouldFilter) {
      await this.options.reconciler.setFilteringEnabled(false);
      await this.waitForIdle();
      await this.options.reconciler.resume();
      await this.options.reconciler.waitForIdle();
      return;
    }
    if (this.hasBaseline) {
      await this.options.reconciler.setFilteringEnabled(true);
      return;
    }
    this.requestRefresh();
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    while (this.run) await this.run;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision += 1;
    if (this.commandRegistrationRetry) clearTimeout(this.commandRegistrationRetry);
    this.commandRegistrationRetry = undefined;
  }

  private shouldFilter(repositories = this.options.getRepositories()): boolean {
    return this.filteringRequested && repositories.length >= minimumRepositoryCount;
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.options.reconciler.compatible) {
      const revision = this.revision;
      const settleMilliseconds = this.options.topologySettleMilliseconds ?? 1_000;
      const remaining = settleMilliseconds - (Date.now() - this.requestedAt);
      if (remaining > 0) await delay(remaining);
      if (this.disposed || !this.options.reconciler.compatible) return;
      if (revision !== this.revision) continue;
      await this.refreshOnce(revision);
      if (revision === this.revision) return;
    }
  }

  private reportUnavailable(reason: VisibilityUnavailableReason): void {
    this.unavailableReason = reason;
    if (this.reportedReason === reason) return;
    this.reportedReason = reason;
    this.options.onUnavailable?.(reason);
  }

  private async standDown(reason: VisibilityUnavailableReason, revision: number): Promise<void> {
    if (revision !== this.revision || this.disposed) return;
    this.reportUnavailable(reason);
    await this.options.reconciler.setFilteringEnabled(false);
    await this.options.reconciler.resume();
    if (reason === 'awaiting-native-commands') this.scheduleCommandRegistrationRetry();
  }

  private scheduleCommandRegistrationRetry(): void {
    if (this.commandRegistrationRetry || this.disposed) return;
    const milliseconds = this.options.commandUnavailableRetryMilliseconds ?? 1_000;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
      throw new Error('Unavailable command retry delay must be a positive safe integer.');
    }
    this.commandRegistrationRetry = setTimeout(() => {
      this.commandRegistrationRetry = undefined;
      if (this.mappingState === 'awaiting-native-commands') this.requestRefresh();
    }, milliseconds);
  }

  private async refreshOnce(revision: number): Promise<void> {
    await this.options.reconciler.pause();
    if (revision !== this.revision || this.disposed) return;
    const repositories = [...this.options.getRepositories()];
    if (!this.shouldFilter(repositories)) {
      await this.options.reconciler.setFilteringEnabled(false);
      if (revision !== this.revision || this.disposed) return;
      await this.options.reconciler.resume();
      return;
    }
    if (!this.options.topologyReady()) {
      await this.standDown('loading-repositories', revision);
      return;
    }

    let commands: readonly string[] | undefined;
    try {
      commands = await this.resolveSettledCommands(repositories.length, revision);
    } catch (error) {
      if (error instanceof HostOperationTimeoutError) {
        await this.standDown('awaiting-native-commands', revision);
        return;
      }
      if (error instanceof OtherScmProvidersError) {
        await this.standDown('other-scm-providers', revision);
        return;
      }
      if (revision === this.revision) await this.options.reconciler.failCompatibility(error);
      return;
    }
    if (!commands) {
      await this.standDown('awaiting-native-commands', revision);
      return;
    }
    if (revision !== this.revision || this.disposed) return;

    try {
      await this.options.resetNativeVisibility();
      this.options.reconciler.acceptAllVisible();
      if (revision !== this.revision || this.disposed) return;

      const mappings = await mapVisibilityCommandsInOrder(
        repositories,
        commands,
        this.options.reconciler,
        {
          ...this.options.probeTimings,
          isCurrent: () => revision === this.revision && !this.disposed,
        },
      );
      if (revision !== this.revision || this.disposed) return;

      this.options.reconciler.setMappings(mappings);
      this.hasBaseline = true;
      this.unavailableReason = undefined;
      this.reportedReason = undefined;
      await this.options.reconciler.setFilteringEnabled(this.shouldFilter());
      await this.options.reconciler.resume();
      this.options.onInitialized?.({ repositoryCount: repositories.length, revision });
    } catch (error) {
      this.hasBaseline = false;
      await this.options.reconciler.restoreOwned();
      if (revision !== this.revision || this.disposed) return;
      if (error instanceof VisibilityProbeInterruptedError) return;
      await this.options.reconciler.failCompatibility(error);
    }
  }

  private async resolveSettledCommands(
    repositoryCount: number,
    revision: number,
  ): Promise<readonly string[] | undefined> {
    const attempts = this.unavailableReason === 'awaiting-native-commands'
      ? 1
      : this.options.commandRetryAttempts ?? 100;
    const retryMilliseconds = this.options.commandRetryMilliseconds ?? 50;
    const timeoutMilliseconds = this.options.commandRetryTimeoutMilliseconds
      ?? DEFAULT_COMMAND_REGISTRATION_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
      throw new Error('Command registration timeout must be a positive safe integer.');
    }
    const deadline = Date.now() + timeoutMilliseconds;
    let lastError: unknown;
    let registrationPending = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (revision !== this.revision || this.disposed) return undefined;
      const remaining = deadline - Date.now();
      if (remaining < 1) break;
      try {
        const registeredCommands = await this.commandEnumeration.wait(
          this.options.getCommands,
          remaining,
          'VS Code command enumeration',
        );
        if (revision !== this.revision || this.disposed) return undefined;
        const discovery = discoverVisibilityCommands(
          repositoryCount,
          registeredCommands,
        );
        registrationPending = discovery.kind === 'pending';
        if (discovery.kind === 'ready') return discovery.commands;
        if (discovery.kind === 'unsupported') {
          throw new VisibilityCompatibilityError(
            'VS Code no longer registers its native repository selection-mode commands, '
            + 'so the internal visibility contract RepoFocus depends on has changed.',
          );
        }
        throw new OtherScmProvidersError(discovery.commandCount, repositoryCount);
      } catch (error) {
        if (error instanceof HostOperationTimeoutError) throw error;
        lastError = error;
        if (attempt + 1 < attempts) {
          const retryRemaining = deadline - Date.now();
          if (retryRemaining < 1) break;
          await delay(Math.min(retryMilliseconds, retryRemaining));
        }
      }
    }
    if (registrationPending) return undefined;
    throw lastError instanceof Error
      ? lastError
      : new Error('Native visibility command discovery failed.');
  }

  private startDrain(): void {
    if (this.run) return;
    this.run = this.drain().finally(() => {
      this.run = undefined;
    });
  }
}
