import type { DisposableLike, GitApi, GitRepository } from './gitApi';

export interface GitRepositoryMonitorCallbacks {
  readonly onRepositoryOpened?: (repository: GitRepository) => void;
  readonly onRepositoryReplaced?: (repository: GitRepository) => void;
  readonly onRepositoryChanged: (repository: GitRepository) => void;
  readonly onRepositoryClosed?: (repository: GitRepository) => void;
}

interface MonitoredRepository {
  readonly repository: GitRepository;
  readonly subscription: DisposableLike;
}

function repositoryKey(repository: GitRepository): string {
  return repository.rootUri.toString();
}

export class GitRepositoryMonitor implements DisposableLike {
  private readonly entries = new Map<string, MonitoredRepository>();
  private readonly apiSubscriptions: DisposableLike[];
  private disposed = false;

  constructor(
    private readonly api: GitApi,
    private readonly callbacks: GitRepositoryMonitorCallbacks,
  ) {
    this.apiSubscriptions = [
      api.onDidOpenRepository(repository => this.add(repository)),
      api.onDidCloseRepository(repository => this.remove(repository)),
    ];
    for (const repository of api.repositories) this.add(repository);
  }

  get repositories(): readonly GitRepository[] {
    return [...this.entries.values()].map(entry => entry.repository);
  }

  getRepository(key: string): GitRepository | undefined {
    return this.entries.get(key)?.repository;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.apiSubscriptions) subscription.dispose();
    for (const entry of this.entries.values()) entry.subscription.dispose();
    this.entries.clear();
  }

  private add(repository: GitRepository): void {
    if (this.disposed) return;
    const key = repositoryKey(repository);
    const previous = this.entries.get(key);
    if (previous?.repository === repository) return;
    previous?.subscription.dispose();
    const subscription = repository.state.onDidChange(() => {
      if (!this.disposed && this.entries.get(key)?.repository === repository) {
        this.callbacks.onRepositoryChanged(repository);
      }
    });
    this.entries.set(key, { repository, subscription });
    if (previous) {
      this.callbacks.onRepositoryReplaced?.(repository);
    } else {
      this.callbacks.onRepositoryOpened?.(repository);
    }
    this.callbacks.onRepositoryChanged(repository);
  }

  private remove(repository: GitRepository): void {
    const key = repositoryKey(repository);
    const entry = this.entries.get(key);
    if (!entry) return;

    // The built-in Git API creates a fresh wrapper for every getter and event.
    // A close event therefore cannot be matched by object identity. If the API
    // still exposes this URI, an out-of-order replacement is current and the
    // stable repository has not closed.
    const replacement = this.api.repositories.find(candidate => repositoryKey(candidate) === key);
    if (replacement) {
      this.add(replacement);
      return;
    }

    entry.subscription.dispose();
    this.entries.delete(key);
    this.callbacks.onRepositoryClosed?.(entry.repository);
  }
}
