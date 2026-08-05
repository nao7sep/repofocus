import { describe, expect, it } from 'vitest';
import type { GitRepositoryState } from '../src/gitApi';
import { toActionabilityInput } from '../src/repositoryStateAdapter';

function state(overrides: Partial<GitRepositoryState> = {}): GitRepositoryState {
  return {
    HEAD: { name: 'main', commit: 'abc', upstream: { remote: 'origin', name: 'main' }, ahead: 0, behind: 0 },
    remotes: [{ name: 'origin' }],
    rebaseCommit: undefined,
    mergeChanges: [],
    indexChanges: [],
    workingTreeChanges: [],
    untrackedChanges: [],
    onDidChange: () => ({ dispose() {} }),
    ...overrides,
  };
}

describe('toActionabilityInput', () => {
  it('adapts every Git state field used by the classifier', () => {
    const input = toActionabilityInput(state({
      HEAD: { name: 'topic', upstream: { remote: 'origin', name: 'topic' }, ahead: 2, behind: 3 },
      remotes: [{ name: 'origin' }, { name: 'backup' }],
      rebaseCommit: {},
      mergeChanges: [{} as never],
      indexChanges: [{} as never, {} as never],
      workingTreeChanges: [{} as never, {} as never, {} as never],
      untrackedChanges: [{} as never, {} as never, {} as never, {} as never],
    }));

    expect(input).toEqual({
      mergeChanges: 1,
      stagedChanges: 2,
      unstagedChanges: 3,
      untrackedChanges: 4,
      rebaseInProgress: true,
      remoteCount: 2,
      branch: { kind: 'named', upstream: 'configured', ahead: 2, behind: 3 },
    });
  });

  it.each([
    ['unpublished', { name: 'topic', commit: 'abc' }, { kind: 'named', upstream: 'missing' }],
    ['detached', { commit: 'abc' }, { kind: 'detached' }],
    ['unknown', {}, { kind: 'unknown', detail: 'Git reported HEAD without a branch name or commit.' }],
  ] as const)('adapts a %s HEAD', (_name, HEAD, expected) => {
    expect(toActionabilityInput(state({ HEAD })).branch).toEqual(expected);
  });

  it('treats an absent HEAD as unborn', () => {
    expect(toActionabilityInput(state({ HEAD: undefined })).branch).toEqual({ kind: 'unborn' });
  });
});
