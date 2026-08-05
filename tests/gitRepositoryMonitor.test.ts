import { describe, expect, it, vi } from 'vitest';
import type {
  DisposableLike,
  EventLike,
  GitApi,
  GitRepository,
  GitRepositoryState,
} from '../src/gitApi';
import { GitRepositoryMonitor } from '../src/gitRepositoryMonitor';

class TestEvent<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  readonly event: EventLike<T> = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of this.listeners) listener(event);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

function repository(name: string): { repository: GitRepository; changes: TestEvent<void> } {
  const changes = new TestEvent<void>();
  const state: GitRepositoryState = {
    HEAD: undefined,
    remotes: [],
    rebaseCommit: undefined,
    mergeChanges: [],
    indexChanges: [],
    workingTreeChanges: [],
    untrackedChanges: [],
    onDidChange: changes.event,
  };
  return {
    repository: { rootUri: { fsPath: `/${name}`, toString: () => `file:///${name}` }, state },
    changes,
  };
}

function api(initial: readonly GitRepository[] = []): {
  api: GitApi;
  opened: TestEvent<GitRepository>;
  closed: TestEvent<GitRepository>;
} {
  const opened = new TestEvent<GitRepository>();
  const closed = new TestEvent<GitRepository>();
  return {
    api: { repositories: initial, onDidOpenRepository: opened.event, onDidCloseRepository: closed.event },
    opened,
    closed,
  };
}

describe('GitRepositoryMonitor', () => {
  it('subscribes to initial repositories and emits an initial evaluation', () => {
    const alpha = repository('alpha');
    const changed = vi.fn();
    const fixture = api([alpha.repository]);
    const monitor = new GitRepositoryMonitor(fixture.api, { onRepositoryChanged: changed });

    expect(monitor.repositories).toEqual([alpha.repository]);
    expect(alpha.changes.listenerCount).toBe(1);
    expect(changed).toHaveBeenCalledWith(alpha.repository);
    monitor.dispose();
  });

  it('adds each opened repository exactly once', () => {
    const alpha = repository('alpha');
    const changed = vi.fn();
    const fixture = api();
    const monitor = new GitRepositoryMonitor(fixture.api, { onRepositoryChanged: changed });

    fixture.opened.fire(alpha.repository);
    fixture.opened.fire(alpha.repository);
    alpha.changes.fire();

    expect(alpha.changes.listenerCount).toBe(1);
    expect(changed).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it('removes repository listeners and reports closure', () => {
    const alpha = repository('alpha');
    const changed = vi.fn();
    const onRepositoryClosed = vi.fn();
    const fixture = api([alpha.repository]);
    const monitor = new GitRepositoryMonitor(fixture.api, { onRepositoryChanged: changed, onRepositoryClosed });

    fixture.closed.fire(alpha.repository);
    alpha.changes.fire();

    expect(alpha.changes.listenerCount).toBe(0);
    expect(monitor.repositories).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(onRepositoryClosed).toHaveBeenCalledWith(alpha.repository);
    monitor.dispose();
  });

  it('ignores an unknown close event', () => {
    const alpha = repository('alpha');
    const fixture = api();
    const onRepositoryClosed = vi.fn();
    const monitor = new GitRepositoryMonitor(fixture.api, {
      onRepositoryChanged: vi.fn(),
      onRepositoryClosed,
    });

    fixture.closed.fire(alpha.repository);
    expect(onRepositoryClosed).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it('disposes API and repository listeners idempotently', () => {
    const alpha = repository('alpha');
    const fixture = api([alpha.repository]);
    const monitor: DisposableLike = new GitRepositoryMonitor(fixture.api, { onRepositoryChanged: vi.fn() });

    monitor.dispose();
    monitor.dispose();

    expect(alpha.changes.listenerCount).toBe(0);
    expect(fixture.opened.listenerCount).toBe(0);
    expect(fixture.closed.listenerCount).toBe(0);
  });
});
