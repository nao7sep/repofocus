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
    repository: {
      rootUri: { fsPath: `/${name}`, toString: () => `file:///${name}` },
      state,
      ui: { selected: false, onDidChange: () => ({ dispose() {} }) },
      fetch: async () => {},
      status: async () => {},
    },
    changes,
  };
}

function api(initial: readonly GitRepository[] = []): {
  api: GitApi;
  opened: TestEvent<GitRepository>;
  closed: TestEvent<GitRepository>;
  setRepositories(repositories: readonly GitRepository[]): void;
} {
  const opened = new TestEvent<GitRepository>();
  const closed = new TestEvent<GitRepository>();
  const stateChanged = new TestEvent<'initialized' | 'uninitialized'>();
  let repositories = initial;
  return {
    api: {
      state: 'initialized',
      onDidChangeState: stateChanged.event,
      get repositories() { return repositories; },
      onDidOpenRepository: opened.event,
      onDidCloseRepository: closed.event,
    },
    opened,
    closed,
    setRepositories: value => { repositories = value; },
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

    fixture.setRepositories([]);
    fixture.closed.fire(alpha.repository);
    alpha.changes.fire();

    expect(alpha.changes.listenerCount).toBe(0);
    expect(monitor.repositories).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(onRepositoryClosed).toHaveBeenCalledWith(alpha.repository);
    monitor.dispose();
  });

  it('matches close events by URI because the Git API returns fresh wrappers', () => {
    const alpha = repository('alpha');
    const openedWrapper = { ...alpha.repository };
    const closedWrapper = { ...alpha.repository };
    const changed = vi.fn();
    const onRepositoryClosed = vi.fn();
    const fixture = api([openedWrapper]);
    const monitor = new GitRepositoryMonitor(fixture.api, { onRepositoryChanged: changed, onRepositoryClosed });

    fixture.setRepositories([]);
    fixture.closed.fire(closedWrapper);
    alpha.changes.fire();

    expect(monitor.repositories).toEqual([]);
    expect(onRepositoryClosed).toHaveBeenCalledWith(openedWrapper);
    expect(changed).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it('replaces a same-URI observation without reporting a topology change', () => {
    const original = repository('alpha');
    const replacement = repository('alpha');
    const changed = vi.fn();
    const onRepositoryOpened = vi.fn();
    const onRepositoryReplaced = vi.fn();
    const fixture = api([original.repository]);
    const monitor = new GitRepositoryMonitor(fixture.api, {
      onRepositoryOpened,
      onRepositoryReplaced,
      onRepositoryChanged: changed,
    });
    onRepositoryOpened.mockClear();
    changed.mockClear();

    fixture.setRepositories([replacement.repository]);
    fixture.opened.fire(replacement.repository);
    original.changes.fire();
    replacement.changes.fire();

    expect(monitor.repositories).toEqual([replacement.repository]);
    expect(onRepositoryOpened).not.toHaveBeenCalled();
    expect(onRepositoryReplaced).toHaveBeenCalledWith(replacement.repository);
    expect(changed).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it('ignores a stale close when a same-URI replacement remains open', () => {
    const original = repository('alpha');
    const replacement = repository('alpha');
    const onRepositoryClosed = vi.fn();
    const fixture = api([original.repository]);
    const monitor = new GitRepositoryMonitor(fixture.api, {
      onRepositoryChanged: vi.fn(),
      onRepositoryClosed,
    });

    fixture.setRepositories([replacement.repository]);
    fixture.opened.fire(replacement.repository);
    fixture.closed.fire({ ...original.repository });

    expect(monitor.repositories).toHaveLength(1);
    expect(monitor.repositories[0]?.rootUri.toString()).toBe('file:///alpha');
    expect(onRepositoryClosed).not.toHaveBeenCalled();
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
