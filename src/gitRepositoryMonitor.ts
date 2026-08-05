import type { DisposableLike, GitApi, GitRepository } from './gitApi';

export interface GitRepositoryMonitorCallbacks {
  readonly onRepositoryOpened?: (repository: GitRepository) => void;
  readonly onRepositoryChanged: (repository: GitRepository) => void;
  readonly onRepositoryClosed?: (repository: GitRepository) => void;
}

export class GitRepositoryMonitor implements DisposableLike {
  private readonly repositorySubscriptions = new Map<GitRepository, DisposableLike>();
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
    return [...this.repositorySubscriptions.keys()];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.apiSubscriptions) subscription.dispose();
    for (const subscription of this.repositorySubscriptions.values()) subscription.dispose();
    this.repositorySubscriptions.clear();
  }

  private add(repository: GitRepository): void {
    if (this.disposed || this.repositorySubscriptions.has(repository)) return;
    const subscription = repository.state.onDidChange(() => {
      if (!this.disposed && this.repositorySubscriptions.has(repository)) {
        this.callbacks.onRepositoryChanged(repository);
      }
    });
    this.repositorySubscriptions.set(repository, subscription);
    this.callbacks.onRepositoryOpened?.(repository);
    this.callbacks.onRepositoryChanged(repository);
  }

  private remove(repository: GitRepository): void {
    const subscription = this.repositorySubscriptions.get(repository);
    if (!subscription) return;
    subscription.dispose();
    this.repositorySubscriptions.delete(repository);
    this.callbacks.onRepositoryClosed?.(repository);
  }
}
