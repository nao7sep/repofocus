import type { GitRepository } from './gitApi';
import {
  mapVisibilityCommandsInOrder,
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

/** A settle wait that resolves true when it elapses and false when it is cancelled. */
class SettleWait {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private finish: ((elapsed: boolean) => void) | undefined;

  wait(milliseconds: number): Promise<boolean> {
    this.cancel();
    return new Promise(resolve => {
      this.finish = resolve;
      this.timer = setTimeout(() => this.end(true), milliseconds);
    });
  }

  cancel(): void {
    this.end(false);
  }

  private end(elapsed: boolean): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const finish = this.finish;
    this.timer = undefined;
    this.finish = undefined;
    finish?.(elapsed);
  }
}

/**
 * The single owner of native visibility. Refresh and recovery requests are
 * applied by one drain, one run at a time; a newer refresh aborts the running
 * run, which stops before its next native command, and the drain coalesces the
 * requests that arrived meanwhile into one run.
 */
export class VisibilityMappingCoordinator {
  private refreshPending = false;
  private recoveryRequested = false;
  private runAbort: AbortController | undefined;
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
    this.refreshPending = true;
    this.runAbort?.abort();
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

  /**
   * Aborts discovery at once; the drain still lets an issued command finish.
   * After a failure, turning filtering off asks the drain to retry the
   * all-visible reset.
   */
  updateFiltering(): void {
    if (this.options.reconciler.compatible) {
      this.requestRefresh(false);
    } else if (!this.disposed && !this.shouldFilter()) {
      this.recoveryRequested = true;
      this.startDrain();
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.run) await this.run;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runAbort?.abort();
    this.settle.cancel();
    if (this.commandRegistrationRetry) clearTimeout(this.commandRegistrationRetry);
    this.commandRegistrationRetry = undefined;
  }

  private shouldFilter(repositories = this.options.getRepositories()): boolean {
    return this.options.filteringRequested() && repositories.length >= minimumRepositoryCount;
  }

  private async drain(): Promise<void> {
    while (!this.disposed) {
      if (!this.options.reconciler.compatible) {
        if (!this.recoveryRequested) return;
        this.recoveryRequested = false;
        await this.options.reconciler.restoreOwned();
        continue;
      }
      if (!this.refreshPending) return;
      const settleMilliseconds = this.options.topologySettleMilliseconds ?? 1_000;
      const remaining = settleMilliseconds - (performance.now() - this.requestedAt);
      // A newer request cancels the wait and restarts it from its own time.
      if (remaining > 0 && !await this.settle.wait(remaining)) continue;
      this.refreshPending = false;
      const run = new AbortController();
      this.runAbort = run;
      await this.refreshOnce(run.signal);
    }
  }

  private reportUnavailable(reason: VisibilityUnavailableReason): void {
    this.unavailableReason = reason;
    if (this.reportedReason === reason) return;
    this.reportedReason = reason;
    this.options.onUnavailable?.(reason);
  }

  private standDown(reason: VisibilityUnavailableReason, signal: AbortSignal): void {
    if (signal.aborted) return;
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

  private async refreshOnce(signal: AbortSignal): Promise<void> {
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
      this.standDown('loading-repositories', signal);
      return;
    }
    let commands: readonly string[] | undefined;
    try {
      commands = await this.resolveSettledCommands(repositories.length, signal);
    } catch (error) {
      if (error instanceof OtherScmProvidersError) {
        this.standDown('other-scm-providers', signal);
      } else if (!signal.aborted) this.options.reconciler.failCompatibility(error);
      return;
    }
    if (signal.aborted) return;
    if (!commands) {
      this.standDown('awaiting-native-commands', signal);
      return;
    }
    try {
      if (!this.nativeAllVisible && !await this.resetBaseline()) return;
      if (signal.aborted) return;
      this.nativeAllVisible = false;
      this.options.reconciler.acceptAllVisible();
      if (!filtering) {
        // Off needs no identity discovery. Retained identities can restore a
        // selection that the reset moved without probing new providers.
        if (this.options.reconciler.hasMappings(repositories, commands)) {
          await this.options.reconciler.apply(repositories, this.savedSelection, signal,
            this.options.probeTimings?.selectionTimeoutMilliseconds);
        }
        this.selectionCaptured = false;
        this.savedSelection = undefined;
        return;
      }
      if (!this.options.reconciler.hasMappings(repositories, commands)) {
        const mappings = await mapVisibilityCommandsInOrder(
          repositories, commands, this.options.reconciler, this.options.probeTimings, signal,
        );
        if (signal.aborted) return;
        this.options.reconciler.setMappings(mappings);
      }
      this.options.reconciler.setFilteringEnabled(true);
      await this.options.reconciler.apply(repositories, this.savedSelection, signal,
        this.options.probeTimings?.selectionTimeoutMilliseconds);
      this.selectionCaptured = false;
      this.savedSelection = undefined;
      this.hasBaseline = true;
      this.unavailableReason = undefined;
      this.reportedReason = undefined;
      this.options.onInitialized?.({ repositoryCount: repositories.length });
    } catch (error) {
      this.hasBaseline = false;
      if (this.disposed) return;
      if (this.options.reconciler.compatible) {
        if (signal.aborted) return;
        this.options.reconciler.failCompatibility(error);
      }
      // A failed toggle or focus probe left native visibility unknown; an
      // all-visible reset, never an inverted ledger, makes it known again.
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
    signal: AbortSignal,
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
      if (signal.aborted) return undefined;
      if (deadline - performance.now() < 1) break;
      try {
        // Each read runs inside this drain turn, so reads never overlap and a
        // superseded run discards its own result below.
        const registeredCommands = await this.options.getCommands();
        if (signal.aborted) return undefined;
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
