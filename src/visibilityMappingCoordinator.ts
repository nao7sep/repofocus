import type { GitRepository } from './gitApi';
import { nativeVisibilityLimitIssue } from './nativeVisibilityLimit';
import {
  establishVisibilityBaseline,
  VisibilityBaselineError,
  type VisibilityBaselineTimings,
} from './visibilityBaseline';
import {
  discoverVisibilityCommands,
  VisibilityCompatibilityError,
} from './visibilityCommandResolver';
import type { VisibilityReconciler } from './visibilityReconciler';

export interface VisibilityInitialization {
  readonly repositoryCount: number;
  readonly revision: number;
}

export interface VisibilityMappingCoordinatorOptions {
  readonly execute: (command: string) => Promise<void>;
  readonly filteringRequested: () => boolean;
  readonly getCommands: () => Promise<readonly string[]>;
  readonly getNativeVisibleLimit: () => number;
  readonly getRepositories: () => readonly GitRepository[];
  readonly minimumRepositoryCount: () => number;
  readonly onInitialized?: (event: VisibilityInitialization) => void;
  readonly reconciler: VisibilityReconciler;
  readonly baselineTimings?: VisibilityBaselineTimings;
  readonly commandRetryAttempts?: number;
  readonly commandRetryMilliseconds?: number;
  readonly commandPollMilliseconds?: number;
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
  private disposed = false;
  private hasBaseline = false;
  private waitingForCommands = false;

  constructor(private readonly options: VisibilityMappingCoordinatorOptions) {}

  get baselineEstablished(): boolean {
    return this.hasBaseline;
  }

  requestRefresh(): void {
    this.queueRefresh(true, true);
  }

  private queueRefresh(settleTopology: boolean, resetCommandWait: boolean): void {
    if (this.disposed || !this.options.reconciler.compatible) return;
    this.revision += 1;
    this.requestedAt = settleTopology
      ? Date.now()
      : Date.now() - (this.options.topologySettleMilliseconds ?? 1_000);
    this.clearCommandPoll();
    if (resetCommandWait) this.waitingForCommands = false;
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

    const visibleLimitIssue = nativeVisibilityLimitIssue(
      repositories.length,
      this.options.getNativeVisibleLimit(),
    );
    if (visibleLimitIssue) {
      if (revision === this.revision) {
        await this.options.reconciler.failCompatibility(new Error(visibleLimitIssue));
      }
      return;
    }

    let commands: readonly string[] | undefined;
    try {
      commands = await this.resolveSettledCommands(repositories.length, revision);
    } catch (error) {
      if (revision === this.revision) await this.options.reconciler.failCompatibility(error);
      return;
    }
    if (!commands) {
      if (revision === this.revision && !this.disposed) {
        this.waitingForCommands = true;
        await this.options.reconciler.setFilteringEnabled(false);
        await this.options.reconciler.resume();
        this.scheduleCommandPoll();
      }
      return;
    }
    if (revision !== this.revision || this.disposed) return;

    try {
      const baseline = await establishVisibilityBaseline(
        repositories,
        commands,
        this.options.execute,
        this.options.baselineTimings,
      );
      this.options.reconciler.replaceKnownVisibility(
        baseline.mappings,
        baseline.hiddenRepositories,
      );
      if (revision !== this.revision || this.disposed) return;

      this.hasBaseline = true;
      this.waitingForCommands = false;
      await this.options.reconciler.setFilteringEnabled(
        this.options.filteringRequested()
          && this.options.getRepositories().length >= this.options.minimumRepositoryCount(),
      );
      await this.options.reconciler.resume();
      this.options.onInitialized?.({ repositoryCount: repositories.length, revision });
    } catch (error) {
      this.hasBaseline = false;
      if (error instanceof VisibilityBaselineError && error.recoveredToAllVisible) {
        this.options.reconciler.replaceKnownVisibility([], []);
      }
      if (revision !== this.revision || this.disposed) return;
      if (error instanceof VisibilityBaselineError && !error.recoveredToAllVisible) {
        await this.options.reconciler.invalidateVisibility(error);
      } else {
        await this.options.reconciler.failCompatibility(error);
      }
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
        throw new VisibilityCompatibilityError(
          `Expected one native visibility command per Git repository; found ${discovery.commandCount} commands for ${repositoryCount} repositories.`,
        );
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

  private scheduleCommandPoll(): void {
    if (this.commandPollTimer || this.disposed || !this.options.reconciler.compatible) return;
    this.commandPollTimer = setTimeout(() => {
      this.commandPollTimer = undefined;
      this.queueRefresh(false, false);
    }, this.options.commandPollMilliseconds ?? 500);
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
