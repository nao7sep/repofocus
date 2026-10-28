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

/** A settle wait that ends early, without error, when it is cancelled. */
class SettleWait {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private finish: (() => void) | undefined;

  wait(milliseconds: number): Promise<void> {
    this.cancel();
    return new Promise(resolve => {
      this.finish = resolve;
      this.timer = setTimeout(() => this.cancel(), milliseconds);
    });
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const finish = this.finish;
    this.timer = undefined;
    this.finish = undefined;
    finish?.();
  }
}

export class VisibilityMappingCoordinator {
  private revision = 0;
  private requestedAt = 0;
  private run: Promise<void> | undefined;
  private disposed = false;
  private hasBaseline = false;
  private touched = false;
  private savedSelection: GitRepository | undefined;
  private selectionCaptured = false;
  /**
   * Native visibility is known to be all-visible and nothing has touched it
   * since, so the pending refresh can map without a reset of its own.
   */
  private nativeAllVisible = false;
  private readonly settle = new SettleWait();
  private unavailableReason: VisibilityUnavailableReason | undefined;
  private reportedReason: VisibilityUnavailableReason | undefined;
  private commandRegistrationRetry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: VisibilityMappingCoordinatorOptions) {
    options.reconciler.onDidChangeDesiredVisibility(() => {
      if (this.shouldFilter()) this.requestRefresh(false);
    });
  }

  get baselineEstablished(): boolean {
    return this.hasBaseline;
  }

  get mappingState(): 'mapped' | 'incompatible' | VisibilityUnavailableReason | 'idle' {
    if (!this.options.reconciler.compatible) return 'incompatible';
    if (this.hasBaseline) return 'mapped';
    return this.unavailableReason ?? 'idle';
  }

  requestRefresh(settleTopology = true): void {
    if (this.disposed || !this.options.reconciler.compatible) return;
    if (this.commandRegistrationRetry) {
      clearTimeout(this.commandRegistrationRetry);
      this.commandRegistrationRetry = undefined;
    }
    this.revision += 1;
    this.requestedAt = settleTopology ? performance.now() : -Infinity;
    if (!this.selectionCaptured) {
      this.savedSelection = this.options.getRepositories().find(repository => repository.ui.selected);
      this.selectionCaptured = true;
    }
    this.hasBaseline = false;
    this.nativeAllVisible = false;
    this.settle.cancel();
    this.startDrain();
  }

  /**
   * Another window's reset passed this window's selection mode through single
   * and back to multiple, and VS Code answers the return to multiple by
   * showing every repository here too. That is the state RepoFocus's own reset
   * produces, so mapping restarts from it without a reset that would in turn
   * pass every other window through the same transition. A toggle still in
   * flight may have landed after the transition, so it forces a real reset.
   */
  acceptForeignReset(): void {
    if (this.disposed || !this.options.reconciler.compatible) return;
    const allVisible = !this.options.reconciler.toggling;
    this.requestRefresh();
    if (!allVisible) return;
    this.options.reconciler.acceptAllVisible();
    this.nativeAllVisible = true;
  }

  refresh(): void {
    this.requestRefresh(false);
  }

  /** Invalidate discovery immediately; the drain still owns issued commands. */
  async updateFiltering(): Promise<void> {
    if (!this.options.reconciler.compatible) {
      if (!this.shouldFilter()) await this.options.reconciler.restoreOwned();
      return;
    }
    this.requestRefresh(false);
    // Preference publication must not wait for a held command or probe.
  }

  async waitForIdle(): Promise<void> {
    while (this.run) await this.run;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision += 1;
    this.settle.cancel();
    if (this.commandRegistrationRetry) clearTimeout(this.commandRegistrationRetry);
    this.commandRegistrationRetry = undefined;
  }

  private shouldFilter(repositories = this.options.getRepositories()): boolean {
    return this.options.filteringRequested() && repositories.length >= minimumRepositoryCount;
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.options.reconciler.compatible) {
      const revision = this.revision;
      const settleMilliseconds = this.options.topologySettleMilliseconds ?? 1_000;
      const remaining = settleMilliseconds - (performance.now() - this.requestedAt);
      if (remaining > 0) await this.settle.wait(remaining);
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
    this.selectionCaptured = false;
    this.savedSelection = undefined;
    this.reportUnavailable(reason);
    this.options.reconciler.setFilteringEnabled(false);
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
    const current = (): boolean => revision === this.revision && !this.disposed;
    if (!current()) return;
    const repositories = [...this.options.getRepositories()];
    const filtering = this.shouldFilter(repositories);
    this.options.reconciler.setFilteringEnabled(false);
    // Preserve no-reset startup when filtering is ineligible. Once a batch has
    // mutated visibility, Off/closure must restore it through a fresh baseline.
    if (!filtering && !this.touched) {
      this.selectionCaptured = false;
      this.savedSelection = undefined;
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
      if (error instanceof OtherScmProvidersError) {
        await this.standDown('other-scm-providers', revision);
      } else if (current()) this.options.reconciler.failCompatibility(error);
      return;
    }
    if (!current()) return;
    if (!commands) {
      await this.standDown('awaiting-native-commands', revision);
      return;
    }
    try {
      if (!this.nativeAllVisible && !await this.resetBaseline()) return;
      if (!current()) return;
      this.nativeAllVisible = false;
      this.options.reconciler.acceptAllVisible();
      if (!filtering) {
        // Off needs no identity discovery. Retained identities can restore a
        // selection that the reset moved without probing new providers.
        if (this.options.reconciler.hasMappings(repositories, commands)) {
          await this.options.reconciler.apply(repositories, this.savedSelection, current,
            this.options.probeTimings?.selectionTimeoutMilliseconds);
        }
        this.selectionCaptured = false;
        this.savedSelection = undefined;
        return;
      }
      if (!this.options.reconciler.hasMappings(repositories, commands)) {
        const mappings = await mapVisibilityCommandsInOrder(repositories, commands, this.options.reconciler, {
          ...this.options.probeTimings, isCurrent: current,
        });
        if (!current()) return;
        this.options.reconciler.setMappings(mappings);
      }
      this.options.reconciler.setFilteringEnabled(true);
      await this.options.reconciler.apply(repositories, this.savedSelection, current,
        this.options.probeTimings?.selectionTimeoutMilliseconds);
      if (!current()) return;
      this.selectionCaptured = false;
      this.savedSelection = undefined;
      this.hasBaseline = true;
      this.unavailableReason = undefined;
      this.reportedReason = undefined;
      this.options.onInitialized?.({ repositoryCount: repositories.length, revision });
    } catch (error) {
      this.hasBaseline = false;
      if (!current() || error instanceof VisibilityProbeInterruptedError) return;
      if (!this.options.reconciler.compatible) return;
      // A failed focus probe left a partial set. Recovery rechecks the supported
      // provider boundary before performing its all-visible reset.
      this.options.reconciler.failCompatibility(error);
      await this.options.reconciler.restoreOwned();
    }
  }

  private async resetBaseline(): Promise<boolean> {
    try {
      this.touched = true;
      await this.options.resetNativeVisibility();
    } catch (error) {
      this.hasBaseline = false;
      // Even an obsolete reset may have changed native visibility before
      // failing. Only the user's off request may retry an untrusted ledger.
      if (!this.disposed) this.options.reconciler.failAllVisibleReset(error);
      return false;
    }
    if (this.disposed) return false;
    this.options.reconciler.acceptAllVisible();
    return this.options.reconciler.compatible;
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
    const deadline = performance.now() + timeoutMilliseconds;
    let lastError: unknown;
    let registrationPending = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (revision !== this.revision || this.disposed) return undefined;
      if (deadline - performance.now() < 1) break;
      try {
        // Each read runs inside this drain turn, so reads never overlap and a
        // superseded run discards its own result below.
        const registeredCommands = await this.options.getCommands();
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
        lastError = error;
        if (attempt + 1 < attempts) {
          const retryRemaining = deadline - performance.now();
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
