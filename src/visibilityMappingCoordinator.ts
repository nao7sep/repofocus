import type { GitRepository } from './gitApi';
import {
  probeVisibilityMappings,
  RepositoriesAlreadyHiddenError,
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

/** Why filtering is not running, when nothing has failed outright. */
export type VisibilityUnavailableReason =
  | 'awaiting-native-commands'
  | 'loading-repositories'
  | 'repositories-already-hidden'
  | 'single-selection-mode'
  | 'other-scm-providers';

export interface VisibilityMappingCoordinatorOptions {
  readonly filteringRequested: () => boolean;
  readonly getCommands: () => Promise<readonly string[]>;
  readonly getRepositories: () => readonly GitRepository[];
  readonly topologyReady?: () => boolean;
  readonly recoverHiddenBaseline?: () => Promise<void>;
  readonly minimumRepositoryCount: () => number;
  readonly multipleSelectionMode: () => boolean;
  readonly reconciler: VisibilityReconciler;
  readonly onInitialized?: (event: VisibilityInitialization) => void;
  readonly onUnavailable?: (reason: VisibilityUnavailableReason) => void;
  readonly probeTimings?: VisibilityProbeTimings;
  readonly commandRetryAttempts?: number;
  readonly commandRetryMilliseconds?: number;
  readonly commandPollMilliseconds?: number;
  readonly commandPollCeilingMilliseconds?: number;
  readonly topologySettleMilliseconds?: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export class VisibilityMappingCoordinator {
  private revision = 0;
  private requestedAt = 0;
  private run: Promise<void> | undefined;
  private commandPollTimer: ReturnType<typeof setTimeout> | undefined;
  private commandPollDelay: number | undefined;
  private disposed = false;
  private hasBaseline = false;
  private waitingForCommands = false;
  private unavailableReason: VisibilityUnavailableReason | undefined;
  private reportedReason: VisibilityUnavailableReason | undefined;
  private mappedRepositoryKeys = new Set<string>();
  private mappedCommands = new Set<string>();
  private hiddenRecoveryAttempted = false;

  constructor(private readonly options: VisibilityMappingCoordinatorOptions) {}

  get baselineEstablished(): boolean {
    return this.hasBaseline;
  }

  /** The state a diagnostics report needs to tell "waiting" from "broken". */
  get mappingState(): 'mapped' | 'incompatible' | VisibilityUnavailableReason | 'idle' {
    if (!this.options.reconciler.compatible) return 'incompatible';
    if (this.hasBaseline) return 'mapped';
    return this.unavailableReason ?? 'idle';
  }

  requestRefresh(): void {
    this.hiddenRecoveryAttempted = false;
    this.queueRefresh(true, true);
  }

  /**
   * The user-driven retry for conditions RepoFocus cannot observe changing:
   * another extension's Source Control provider disappearing, or repositories
   * being revealed through VS Code's own menu. Neither produces an event, so a
   * manual refresh is the retry rather than a background poll.
   */
  retryIfUnavailable(): void {
    if (this.mappingState === 'mapped') return;
    this.requestRefresh();
  }

  /**
   * A cheap convergence check for startup, remote-refresh completion, and a
   * low-frequency timer. It never probes or toggles a healthy mapping.
   */
  async audit(): Promise<void> {
    if (this.disposed || !this.options.reconciler.compatible || this.run) return;
    const repositories = [...this.options.getRepositories()];
    const shouldFilter = this.options.filteringRequested()
      && repositories.length >= this.options.minimumRepositoryCount();
    if (!shouldFilter) {
      await this.updateFiltering();
      return;
    }
    if (this.options.topologyReady?.() === false || !this.hasBaseline) {
      this.requestRefresh();
      return;
    }

    try {
      const discovery = discoverVisibilityCommands(
        repositories.length,
        await this.options.getCommands(),
      );
      const repositoryKeys = new Set(repositories.map(repository => repository.rootUri.toString()));
      if (
        discovery.kind === 'ready'
        && sameSet(repositoryKeys, this.mappedRepositoryKeys)
        && sameSet(new Set(discovery.commands), this.mappedCommands)
        && this.options.reconciler.enabled
      ) {
        return;
      }
    } catch {
      // The normal refresh path classifies and reports the exact failure.
    }
    this.requestRefresh();
  }

  private queueRefresh(settleTopology: boolean, resetCommandWait: boolean): void {
    if (this.disposed || !this.options.reconciler.compatible) return;
    this.revision += 1;
    this.requestedAt = settleTopology
      ? Date.now()
      : Date.now() - (this.options.topologySettleMilliseconds ?? 1_000);
    this.clearCommandPoll();
    if (resetCommandWait) {
      this.waitingForCommands = false;
      this.commandPollDelay = undefined;
    }
    this.hasBaseline = false;
    void this.options.reconciler.pause();
    this.startDrain();
  }

  async updateFiltering(): Promise<void> {
    const repositories = this.options.getRepositories();
    const shouldFilter = this.options.filteringRequested()
      && repositories.length >= this.options.minimumRepositoryCount();
    if (!shouldFilter) {
      this.clearCommandPoll();
      this.waitingForCommands = false;
      await this.options.reconciler.setFilteringEnabled(false);
      await this.waitForIdle();
      this.clearCommandPoll();
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
    this.clearCommandPoll();
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

  /** Reports a non-failure reason once per distinct state, never silently. */
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
  }

  private async refreshOnce(revision: number): Promise<void> {
    const repositories = [...this.options.getRepositories()];
    const shouldFilter = this.options.filteringRequested()
      && repositories.length >= this.options.minimumRepositoryCount();
    if (!shouldFilter) {
      await this.options.reconciler.setFilteringEnabled(false);
      if (revision !== this.revision || this.disposed) return;
      await this.options.reconciler.resume();
      return;
    }

    if (this.options.topologyReady?.() === false) {
      await this.standDown('loading-repositories', revision);
      return;
    }

    // `single` mode can show only one repository at a time, so the whole model
    // is impossible there. RepoFocus reads the setting and never writes it.
    if (!this.options.multipleSelectionMode()) {
      await this.standDown('single-selection-mode', revision);
      return;
    }

    let commands: readonly string[] | undefined;
    try {
      commands = await this.resolveSettledCommands(repositories.length, revision);
    } catch (error) {
      // Another SCM provider is present: unsupported, not incompatible, so it
      // stays recoverable instead of ending filtering for the window.
      if (error instanceof OtherScmProvidersError) {
        await this.standDown('other-scm-providers', revision);
        return;
      }
      if (revision === this.revision) await this.options.reconciler.failCompatibility(error);
      return;
    }
    if (!commands) {
      if (revision === this.revision && !this.disposed) {
        this.waitingForCommands = true;
        await this.standDown('awaiting-native-commands', revision);
        this.scheduleCommandPoll();
      }
      return;
    }
    if (revision !== this.revision || this.disposed) return;

    // Mapping by elimination needs the state RepoFocus found, not the one it
    // created: a re-probe after a topology change would otherwise see its own
    // hidden repositories and mistake them for the user's. The ledger restores
    // exactly what RepoFocus hid, which is why no all-visible sweep is needed.
    await this.options.reconciler.restoreOwned();
    if (revision !== this.revision || this.disposed) return;

    try {
      const mappings = await probeVisibilityMappings(
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
      this.mappedRepositoryKeys = new Set(
        mappings.map(mapping => mapping.repository.rootUri.toString()),
      );
      this.mappedCommands = new Set(mappings.map(mapping => mapping.command));
      this.waitingForCommands = false;
      this.unavailableReason = undefined;
      this.reportedReason = undefined;
      await this.options.reconciler.setFilteringEnabled(
        this.options.filteringRequested()
          && this.options.getRepositories().length >= this.options.minimumRepositoryCount(),
      );
      await this.options.reconciler.resume();
      this.options.onInitialized?.({ repositoryCount: repositories.length, revision });
    } catch (error) {
      this.hasBaseline = false;
      // The ledger knows exactly what the probe hid, whatever went wrong.
      await this.options.reconciler.restoreOwned();
      if (revision !== this.revision || this.disposed) return;
      if (error instanceof RepositoriesAlreadyHiddenError) {
        if (this.options.recoverHiddenBaseline && !this.hiddenRecoveryAttempted) {
          this.hiddenRecoveryAttempted = true;
          try {
            await this.options.recoverHiddenBaseline();
          } catch (recoveryError) {
            await this.options.reconciler.failCompatibility(recoveryError);
            return;
          }
          if (revision !== this.revision || this.disposed) return;
          this.queueRefresh(false, false);
          return;
        }
        await this.standDown('repositories-already-hidden', revision);
        return;
      }
      await this.options.reconciler.failCompatibility(error);
    }
  }

  private async resolveSettledCommands(
    repositoryCount: number,
    revision: number,
  ): Promise<readonly string[] | undefined> {
    const attempts = this.waitingForCommands ? 1 : (this.options.commandRetryAttempts ?? 20);
    const retryMilliseconds = this.options.commandRetryMilliseconds ?? 50;
    let lastError: unknown;
    let registrationPending = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (revision !== this.revision || this.disposed) return undefined;
      try {
        const discovery = discoverVisibilityCommands(
          repositoryCount,
          await this.options.getCommands(),
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
        if (attempt + 1 < attempts) await delay(retryMilliseconds);
      }
    }
    if (registrationPending) return undefined;
    throw lastError instanceof Error
      ? lastError
      : new Error('Native visibility command discovery failed.');
  }

  /**
   * Backs off rather than sweeping every command id twice a second forever: the
   * usual reason for this state is simply that Source Control has not been
   * opened yet, and that can last a whole session.
   */
  private scheduleCommandPoll(): void {
    if (this.commandPollTimer || this.disposed || !this.options.reconciler.compatible) return;
    const base = this.options.commandPollMilliseconds ?? 500;
    const ceiling = this.options.commandPollCeilingMilliseconds ?? 10_000;
    const next = this.commandPollDelay === undefined
      ? base
      : Math.min(this.commandPollDelay * 4, ceiling);
    this.commandPollDelay = next;
    this.commandPollTimer = setTimeout(() => {
      this.commandPollTimer = undefined;
      this.queueRefresh(false, false);
    }, next);
  }

  private startDrain(): void {
    if (this.run) return;
    this.run = this.drain().finally(() => {
      this.run = undefined;
    });
  }

  private clearCommandPoll(): void {
    if (!this.commandPollTimer) return;
    clearTimeout(this.commandPollTimer);
    this.commandPollTimer = undefined;
  }
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
