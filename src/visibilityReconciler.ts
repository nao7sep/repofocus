import type { RepositoryActionability } from './actionability';
import type { RepositoryIdentity, VisibilityMapping } from './visibilityCommandResolver';

export type ToggleVisibility = (command: string) => Promise<void>;

export interface VisibilityReconcilerOptions {
  readonly toggle: ToggleVisibility;
  readonly onError?: (error: Error) => void;
}

type ReconcilerState = 'active' | 'failed' | 'disposed';

function repositoryKey(repository: RepositoryIdentity): string {
  return repository.rootUri.toString();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class VisibilityReconciler {
  private readonly actionability = new Map<string, RepositoryActionability>();
  private readonly hiddenByRepoFocus = new Set<string>();
  private readonly mappings = new Map<string, VisibilityMapping>();
  private state: ReconcilerState = 'active';
  private filteringEnabled = true;
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

  setFilteringEnabled(enabled: boolean): Promise<void> {
    if (this.filteringEnabled === enabled) return this.queue;
    this.filteringEnabled = enabled;
    if (enabled && this.state === 'active') {
      this.requestReconcile();
    } else {
      this.requested = false;
      this.queue = this.queue.then(() => this.restoreOwnedRepositories());
    }
    return this.queue;
  }

  replaceMappings(mappings: readonly VisibilityMapping[]): void {
    if (this.state !== 'active') return;
    this.mappings.clear();
    for (const mapping of mappings) this.mappings.set(repositoryKey(mapping.repository), mapping);
    this.requestReconcile();
  }

  adoptAllVisible(mappings: readonly VisibilityMapping[]): void {
    if (this.state !== 'active') return;
    this.hiddenByRepoFocus.clear();
    this.replaceMappings(mappings);
  }

  setActionability(repository: RepositoryIdentity, value: RepositoryActionability): void {
    if (this.state !== 'active') return;
    this.actionability.set(repositoryKey(repository), value);
    this.requestReconcile();
  }

  removeRepository(repository: RepositoryIdentity): void {
    const key = repositoryKey(repository);
    this.actionability.delete(key);
    this.hiddenByRepoFocus.delete(key);
    this.mappings.delete(key);
  }

  isHiddenByRepoFocus(repository: RepositoryIdentity): boolean {
    return this.hiddenByRepoFocus.has(repositoryKey(repository));
  }

  waitForIdle(): Promise<void> {
    return this.queue;
  }

  failCompatibility(error: unknown): Promise<void> {
    if (this.state !== 'active') return this.queue;
    this.state = 'failed';
    this.options.onError?.(asError(error));
    this.requested = false;
    this.queue = this.queue.then(() => this.restoreOwnedRepositories());
    return this.queue;
  }

  async showAll(): Promise<void> {
    this.requested = false;
    await this.queue;
    await this.restoreOwnedRepositories();
  }

  async shutdown(): Promise<void> {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.requested = false;
    await this.queue;
    await this.restoreOwnedRepositories();
    this.actionability.clear();
    this.mappings.clear();
  }

  private requestReconcile(): void {
    this.requested = true;
    if (this.scheduled) return;
    this.scheduled = true;
    this.queue = this.queue.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.requested && this.state === 'active' && this.filteringEnabled) {
        this.requested = false;
        await this.reconcileOnce();
      }
    } finally {
      this.scheduled = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    for (const [key, mapping] of this.mappings) {
      if (this.state !== 'active') return;
      const value = this.actionability.get(key);
      if (!value) continue;

      const hidden = this.hiddenByRepoFocus.has(key);
      if (!value.actionable && !hidden) {
        try {
          await this.options.toggle(mapping.command);
          this.hiddenByRepoFocus.add(key);
        } catch (error) {
          await this.handleToggleFailure(error);
          return;
        }
      } else if (value.actionable && hidden) {
        try {
          await this.options.toggle(mapping.command);
          this.hiddenByRepoFocus.delete(key);
        } catch (error) {
          await this.handleToggleFailure(error);
          return;
        }
      }
    }
  }

  private async handleToggleFailure(error: unknown): Promise<void> {
    if (this.state === 'active') {
      this.state = 'failed';
      this.options.onError?.(asError(error));
    }
    this.requested = false;
    await this.restoreOwnedRepositories();
  }

  private async restoreOwnedRepositories(): Promise<void> {
    for (const key of [...this.hiddenByRepoFocus]) {
      const mapping = this.mappings.get(key);
      if (!mapping) continue;
      try {
        await this.options.toggle(mapping.command);
        this.hiddenByRepoFocus.delete(key);
      } catch (error) {
        this.options.onError?.(new Error('Failed to restore a repository hidden by RepoFocus.', {
          cause: asError(error),
        }));
        // Retain the key so a later explicit recovery attempt can retry it.
      }
    }
  }
}
