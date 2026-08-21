import { describe, expect, it } from 'vitest';
import {
  classifyRepository,
  type RepositoryActionabilityInput,
} from '../src/actionability';

function cleanInput(
  overrides: Partial<RepositoryActionabilityInput> = {},
): RepositoryActionabilityInput {
  return {
    mergeChanges: 0,
    stagedChanges: 0,
    unstagedChanges: 0,
    untrackedChanges: 0,
    rebaseInProgress: false,
    remoteCount: 1,
    branch: { kind: 'named', upstream: 'configured', ahead: 0, behind: 0 },
    ...overrides,
  };
}

function reasonKinds(input: RepositoryActionabilityInput): string[] {
  return classifyRepository(input).reasons.map(reason => reason.kind);
}

describe('classifyRepository', () => {
  it('classifies a synchronized repository as clean', () => {
    expect(classifyRepository(cleanInput())).toEqual({ actionable: false, reasons: [] });
  });

  it.each([
    ['conflicts', { mergeChanges: 2 }],
    ['staged', { stagedChanges: 1 }],
    ['unstaged', { unstagedChanges: 3 }],
    ['untracked', { untrackedChanges: 4 }],
    ['rebase', { rebaseInProgress: true }],
  ] as const)('reports %s working state', (reason, overrides) => {
    expect(reasonKinds(cleanInput(overrides))).toContain(reason);
  });

  it('records every simultaneous reason in stable order', () => {
    expect(reasonKinds(cleanInput({
      mergeChanges: 1,
      stagedChanges: 2,
      unstagedChanges: 3,
      untrackedChanges: 4,
      rebaseInProgress: true,
      branch: { kind: 'named', upstream: 'configured', ahead: 5, behind: 6 },
    }))).toEqual([
      'conflicts',
      'staged',
      'unstaged',
      'untracked',
      'rebase',
      'incoming',
      'outgoing',
    ]);
  });

  it.each([
    ['ahead', { ahead: 2, behind: 0 }, ['outgoing']],
    ['behind', { ahead: 0, behind: 2 }, ['incoming']],
    ['diverged', { ahead: 2, behind: 3 }, ['incoming', 'outgoing']],
  ] as const)('classifies a %s branch', (_name, counts, expected) => {
    const input = cleanInput({ branch: { kind: 'named', upstream: 'configured', ...counts } });
    expect(reasonKinds(input)).toEqual(expected);
  });

  it('classifies a named branch without an upstream as unpublished when a remote exists', () => {
    expect(reasonKinds(cleanInput({
      branch: { kind: 'named', upstream: 'missing' },
      remoteCount: 1,
    }))).toEqual(['unpublished']);
  });

  it.each([
    ['local-only', cleanInput({ branch: { kind: 'named', upstream: 'missing' }, remoteCount: 0 })],
    ['detached', cleanInput({ branch: { kind: 'detached' } })],
    ['unborn', cleanInput({ branch: { kind: 'unborn' } })],
  ])('does not invent remote work for a %s repository', (_name, input) => {
    expect(reasonKinds(input)).toEqual([]);
  });

  it('keeps an evaluation failure visible', () => {
    const result = classifyRepository(cleanInput({ evaluationError: 'Git state unavailable.' }));
    expect(result.actionable).toBe(true);
    expect(result.reasons).toEqual([{ kind: 'error', detail: 'Git state unavailable.' }]);
  });

  it('keeps an always-show repository visible without Git work', () => {
    expect(reasonKinds(cleanInput({ alwaysShow: true }))).toEqual(['always-show']);
  });

  it('keeps unknown branch state visible', () => {
    expect(reasonKinds(cleanInput({ branch: { kind: 'unknown', detail: 'HEAD is inconsistent.' } })))
      .toEqual(['error']);
  });

  it.each([
    ['negative', { stagedChanges: -1 }],
    ['fractional', { untrackedChanges: 0.5 }],
    ['missing ahead', { branch: { kind: 'named', upstream: 'configured', behind: 0 } }],
    ['missing behind', { branch: { kind: 'named', upstream: 'configured', ahead: 0 } }],
  ] as const)('keeps %s count data visible as an error', (_name, overrides) => {
    expect(reasonKinds(cleanInput(overrides))).toContain('error');
  });

});
