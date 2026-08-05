import { describe, expect, it } from 'vitest';
import type { EventLike, GitRepository, GitRepositoryState } from '../src/gitApi';
import { establishAllVisibleBaseline } from '../src/visibilityBaseline';
import type { VisibilityMapping } from '../src/visibilityCommandResolver';

class VisibilityFixture {
  readonly repositories: GitRepository[];
  readonly mappings: VisibilityMapping[];
  readonly visible = new Set<string>();
  private selected: string | undefined;

  constructor(names: readonly string[], initiallyVisible: readonly string[]) {
    for (const name of initiallyVisible) this.visible.add(name);
    this.selected = initiallyVisible[0];
    const event: EventLike<void> = () => ({ dispose() {} });
    const state = {
      HEAD: undefined,
      remotes: [],
      rebaseCommit: undefined,
      mergeChanges: [],
      indexChanges: [],
      workingTreeChanges: [],
      untrackedChanges: [],
      onDidChange: event,
    } satisfies GitRepositoryState;
    this.repositories = names.map(name => ({
      rootUri: { fsPath: `/${name}`, toString: () => `file:///${name}` },
      state,
      ui: {
        get selected() { return false; },
        onDidChange: event,
      },
      fetch: async () => {},
      status: async () => {},
    }));
    for (const repository of this.repositories) {
      const name = repository.rootUri.fsPath.slice(1);
      Object.defineProperty(repository.ui, 'selected', { get: () => this.selected === name });
    }
    this.mappings = this.repositories.map(repository => ({
      repository,
      command: `toggle.${repository.rootUri.fsPath.slice(1)}`,
    }));
  }

  readonly toggle = (command: string): Promise<void> => {
    const name = command.slice('toggle.'.length);
    if (this.visible.has(name)) {
      this.visible.delete(name);
      if (this.selected === name) {
        const next = this.repositories
          .map(repository => repository.rootUri.fsPath.slice(1))
          .find(candidate => this.visible.has(candidate));
        if (next) this.selected = next;
        // VS Code leaves SourceControl.selected stale when the final visible
        // repository is hidden, so retain the old value when there is no next one.
      }
    } else {
      this.visible.add(name);
    }
    return Promise.resolve();
  };
}

describe('establishAllVisibleBaseline', () => {
  it.each([
    ['all visible', ['alpha', 'beta', 'gamma']],
    ['some visible', ['beta']],
    ['none visible', []],
  ])('normalizes %s repositories to all visible', async (_name, initiallyVisible) => {
    const fixture = new VisibilityFixture(['alpha', 'beta', 'gamma'], initiallyVisible);
    await establishAllVisibleBaseline(fixture.repositories, fixture.mappings, fixture.toggle, 1);
    expect([...fixture.visible].sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('rejects an incomplete mapping before changing visibility', async () => {
    const fixture = new VisibilityFixture(['alpha', 'beta'], ['alpha', 'beta']);
    await expect(establishAllVisibleBaseline(
      fixture.repositories,
      fixture.mappings.slice(0, 1),
      fixture.toggle,
      1,
    )).rejects.toThrow('Every Git repository');
    expect([...fixture.visible].sort()).toEqual(['alpha', 'beta']);
  });
});
