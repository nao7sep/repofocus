import type { RepositoryActionability } from './actionability';
import type { RepositoryIdentity, VisibilityMapping } from './visibilityCommandResolver';

export type ToggleVisibility = (command: string) => Promise<void>;

export interface VisibilityFailure {
  /** Commands RepoFocus invoked to hide a repository and could not undo. */
  readonly strandedCommandCount: number;
}

export interface VisibilityReconcilerOptions {
  readonly toggle: ToggleVisibility;
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
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: VisibilityReconcilerOptions) {}

  get compatible(): boolean {
    return this.state === 'active';
  }

  get enabled(): boolean {
    return this.filteringEnabled;
  }

  get hiddenRepositoryCount(): number {
    return this.hiddenCommands.size;
  }

  /**
   * Executes a hide and records it before the command runs. A rejected toggle
   * leaves the record in place so recovery retries it: a repository wrongly
   * believed hidden is revealed again, while the opposite mistake would leave a
   * changed repository invisible.
   */
  async hide(command: string): Promise<void> {
    this.hiddenCommands.add(command);
    await this.options.toggle(command);
  }

  async reveal(command: string): Promise<void> {
    await this.options.toggle(command);
    this.hiddenCommands.delete(command);
  }

  setMappings(mappings: readonly VisibilityMapping[]): void {
    if (this.state !== 'active') return;
    this.mappings.clear();
    for (const mapping of mappings) this.mappings.set(repositoryKey(mapping.repository), mapping);
    this.requestReconcile();
  }

  setFilteringEnabled(enabled: boolean): Promise<void> {
    this.filteringEnabled = enabled;
    if (this.state === 'active') {
      this.requestReconcile();
    } else if (!enabled) {
      this.queue = this.queue.then(() => this.restoreOwnedCommands());
    }
    return this.queue;
  }

  pause(): Promise<void> {
    if (this.state !== 'active') return this.queue;
    this.paused = true;
    this.requested = false;
    return this.queue;
  }

  resume(): Promise<void> {
    if (this.state !== 'active') return this.queue;
    this.paused = false;
    this.requestReconcile();
    return this.queue;
  }

  setActionability(repository: RepositoryIdentity, value: RepositoryActionability): void {
    if (this.state !== 'active') return;
    this.actionability.set(repositoryKey(repository), value);
    this.requestReconcile();
  }

  removeRepository(repository: RepositoryIdentity): void {
    const key = repositoryKey(repository);
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

  async shutdown(): Promise<void> {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.paused = false;
    this.requested = false;
    await this.queue;
    await this.restoreOwnedCommands();
    this.actionability.clear();
    this.mappings.clear();
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
        await this.handleToggleFailure(error);
        return;
      }
    }
  }

  private async handleToggleFailure(error: unknown): Promise<void> {
    if (this.state === 'active') {
      this.state = 'failed';
      this.options.onError?.(asError(error), { strandedCommandCount: this.hiddenCommands.size });
    }
    this.requested = false;
    await this.restoreOwnedCommands();
  }

  private async restoreOwnedCommands(): Promise<void> {
    for (const command of [...this.hiddenCommands]) {
      try {
        await this.reveal(command);
      } catch (error) {
        this.options.onError?.(
          new Error('Failed to restore a repository hidden by RepoFocus.', { cause: asError(error) }),
          { strandedCommandCount: this.hiddenCommands.size },
        );
      }
    }
  }
}
