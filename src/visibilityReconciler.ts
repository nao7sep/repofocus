import type { RepositoryActionability } from './actionability';
import type { RepositoryIdentity, VisibilityMapping } from './visibilityCommandResolver';

export type ToggleVisibility = (command: string) => Promise<void>;

export interface VisibilityFailure {
  /** Commands RepoFocus invoked to hide a repository and could not undo. */
  readonly strandedCommandCount: number;
}

export interface VisibilityReconcilerOptions {
  readonly toggle: ToggleVisibility;
  /** Re-establishes a known all-visible state without relying on another toggle. */
  readonly resetToAllVisible?: () => Promise<void>;
  readonly onError?: (error: Error, failure: VisibilityFailure) => void;
}

type ReconcilerState = 'active' | 'failed' | 'disposed';

function repositoryKey(repository: RepositoryIdentity): string {
  return repository.rootUri.toString();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Owns every native visibility mutation RepoFocus makes.
 *
 * Ownership is tracked by *command*, not by repository, because the mapping
 * probe must toggle commands before it knows which repository each one belongs
 * to. A command is the only thing RepoFocus can reliably undo, so it is the
 * only thing recorded.
 */
export class VisibilityReconciler {
  private readonly actionability = new Map<string, RepositoryActionability>();
  private readonly mappings = new Map<string, VisibilityMapping>();
  private readonly hiddenCommands = new Set<string>();
  private state: ReconcilerState = 'active';
  private filteringEnabled = false;
  private paused = false;
  private requested = false;
  private scheduled = false;
  /** False once a toggle outcome is unknown; the ledger can then no longer be inverted. */
  private ledgerTrusted = true;
  /** The all-visible reset in flight or already succeeded; a failed one is cleared for retry. */
  private ambiguousRecovery: Promise<boolean> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private pendingToggles = 0;

  constructor(private readonly options: VisibilityReconcilerOptions) {}

  get compatible(): boolean {
    return this.state === 'active';
  }

  /** Whether filtering is applied now; a failed or disposed reconciler filters nothing. */
  get enabled(): boolean {
    return this.state === 'active' && this.filteringEnabled;
  }

  get hiddenRepositoryCount(): number {
    return this.hiddenCommands.size;
  }

  /**
   * True while a native toggle has been sent and its completion not yet seen.
   * Such a toggle may land after a native transition observed meanwhile.
   */
  get toggling(): boolean {
    return this.pendingToggles > 0;
  }

  async hide(command: string): Promise<void> {
    this.hiddenCommands.add(command);
    try {
      await this.toggle(command);
    } catch (error) {
      await this.failAmbiguousToggle(error);
      throw error;
    }
  }

  async reveal(command: string): Promise<void> {
    try {
      await this.toggle(command);
    } catch (error) {
      await this.failAmbiguousToggle(error);
      throw error;
    }
    this.hiddenCommands.delete(command);
  }

  setMappings(mappings: readonly VisibilityMapping[]): void {
    if (this.state !== 'active') return;
    this.mappings.clear();
    for (const mapping of mappings) this.mappings.set(repositoryKey(mapping.repository), mapping);
    this.requestReconcile();
  }

  /** Accepts a completed native all-visible reset as the new owned baseline. */
  acceptAllVisible(): void {
    if (this.state !== 'active') return;
    this.hiddenCommands.clear();
    this.mappings.clear();
  }

  setFilteringEnabled(enabled: boolean): Promise<void> {
    if (this.state === 'failed') {
      // Filtering cannot resume after a failure. Turning it off is the user's
      // retry for re-showing what RepoFocus hid, including a failed reset.
      if (!enabled) this.queue = this.queue.then(() => this.restoreOwnedCommands());
      return this.queue;
    }
    if (this.state !== 'active' || this.filteringEnabled === enabled) return this.queue;
    this.filteringEnabled = enabled;
    this.requestReconcile();
    return this.queue;
  }

  pause(): Promise<void> {
    if (this.state !== 'active' || this.paused) return this.queue;
    this.paused = true;
    this.requested = false;
    return this.queue;
  }

  resume(): Promise<void> {
    if (this.state !== 'active' || !this.paused) return this.queue;
    this.paused = false;
    this.requestReconcile();
    return this.queue;
  }

  setActionability(repository: RepositoryIdentity, value: RepositoryActionability): void {
    if (this.state !== 'active') return;
    const key = repositoryKey(repository);
    const previous = this.actionability.get(key);
    this.actionability.set(key, value);
    // Visibility is the reconciler's only decision. Git emits state events for
    // many changes that alter counts or metadata without changing whether the
    // repository should be shown; those must not start another O(repositories)
    // pass through the mapping.
    if (previous?.actionable === value.actionable) return;
    this.requestReconcile();
  }

  removeRepository(repository: RepositoryIdentity): void {
    const key = repositoryKey(repository);
    const mapping = this.mappings.get(key);
    // VS Code unregisters the visibility command along with the provider, so
    // owning it is meaningless once the repository closes: retaining it would
    // retry a command that can no longer exist — reported as a compatibility
    // failure — and inflate every count RepoFocus publishes.
    if (mapping) this.hiddenCommands.delete(mapping.command);
    this.actionability.delete(key);
    this.mappings.delete(key);
  }

  isHiddenByRepoFocus(repository: RepositoryIdentity): boolean {
    const mapping = this.mappings.get(repositoryKey(repository));
    return mapping !== undefined && this.hiddenCommands.has(mapping.command);
  }

  waitForIdle(): Promise<void> {
    return this.queue;
  }

  /** Restores everything RepoFocus hid without ending its own compatibility. */
  restoreOwned(): Promise<void> {
    this.queue = this.queue.then(() => this.restoreOwnedCommands());
    return this.queue;
  }

  failCompatibility(error: unknown): Promise<void> {
    if (this.state !== 'active') return this.queue;
    this.state = 'failed';
    this.paused = false;
    this.requested = false;
    this.options.onError?.(asError(error), { strandedCommandCount: this.hiddenCommands.size });
    this.queue = this.queue.then(() => this.restoreOwnedCommands());
    return this.queue;
  }

  /**
   * VS Code disposes extension subscriptions after it has already cut the
   * extension's connection to the workbench, so nothing can be re-shown here.
   * Disposal only stops further work and failure reports.
   */
  dispose(): void {
    this.state = 'disposed';
    this.requested = false;
  }

  private async toggle(command: string): Promise<void> {
    this.pendingToggles += 1;
    try {
      await this.options.toggle(command);
    } finally {
      this.pendingToggles -= 1;
    }
  }

  private requestReconcile(): void {
    this.requested = true;
    if (this.scheduled || this.paused || this.state !== 'active') return;
    this.scheduled = true;
    this.queue = this.queue.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.requested && this.state === 'active' && !this.paused) {
        this.requested = false;
        await this.reconcileOnce();
      }
    } finally {
      this.scheduled = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    for (const [key, mapping] of this.mappings) {
      if (this.state !== 'active' || this.paused) return;
      const value = this.actionability.get(key);
      const shouldBeHidden = this.filteringEnabled && value?.actionable === false;
      if (shouldBeHidden === this.hiddenCommands.has(mapping.command)) continue;
      try {
        if (shouldBeHidden) {
          await this.hide(mapping.command);
        } else {
          await this.reveal(mapping.command);
        }
      } catch (error) {
        // hide()/reveal() already stopped filtering and attempted a known-state
        // reset. Do not compensate for an ambiguous toggle with another toggle.
        return;
      }
    }
  }

  /**
   * A busy refusal never started its command, but it means an earlier command
   * is still unsettled, so native visibility is just as unknown and the same
   * recovery applies.
   */
  private failAmbiguousToggle(error: unknown): Promise<boolean> {
    if (this.state === 'disposed') return Promise.resolve(false);
    if (!this.ledgerTrusted) return this.resetAfterAmbiguousToggle();
    this.ledgerTrusted = false;
    this.state = 'failed';
    this.requested = false;
    this.options.onError?.(asError(error), { strandedCommandCount: this.hiddenCommands.size });
    return this.resetAfterAmbiguousToggle();
  }

  /** Resolves whether the all-visible baseline was established. */
  private resetAfterAmbiguousToggle(): Promise<boolean> {
    this.ambiguousRecovery ??= this.attemptAllVisibleReset().then(succeeded => {
      if (!succeeded) this.ambiguousRecovery = undefined;
      return succeeded;
    });
    return this.ambiguousRecovery;
  }

  private async attemptAllVisibleReset(): Promise<boolean> {
    if (!this.options.resetToAllVisible) return false;
    try {
      await this.options.resetToAllVisible();
      this.hiddenCommands.clear();
      this.mappings.clear();
      return true;
    } catch (error) {
      if (this.state === 'disposed') return false;
      this.options.onError?.(
        new Error('Failed to establish an all-visible baseline after an ambiguous native toggle.', {
          cause: asError(error),
        }),
        { strandedCommandCount: this.hiddenCommands.size },
      );
      return false;
    }
  }

  private async restoreOwnedCommands(): Promise<void> {
    if (this.state === 'disposed') return;
    // Once a toggle outcome is ambiguous, the ledger is no longer safe to
    // invert. The all-visible reset is the only permitted recovery.
    if (!this.ledgerTrusted) {
      await this.resetAfterAmbiguousToggle();
      return;
    }
    for (const command of [...this.hiddenCommands]) {
      try {
        await this.reveal(command);
      } catch (error) {
        // reveal() has already invalidated the toggle ledger and attempted the
        // only safe recovery. Continuing would compound an unknown native state.
        return;
      }
    }
  }
}
