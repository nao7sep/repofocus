import { describe, expect, it } from 'vitest';
import { discoverVisibilityCommands } from '../src/visibilityCommandResolver';

describe('discoverVisibilityCommands', () => {
  it('sorts native visibility commands by SCM handle', () => {
    const commands = [
      'unrelated.command',
      'workbench.scm.action.toggleRepositoryVisibility.scm7',
      'workbench.scm.action.toggleRepositoryVisibility.scm6',
    ];

    expect(discoverVisibilityCommands(2, commands)).toEqual({
      kind: 'ready',
      commands: [
        'workbench.scm.action.toggleRepositoryVisibility.scm6',
        'workbench.scm.action.toggleRepositoryVisibility.scm7',
      ],
    });
  });

  it('classifies excess commands instead of guessing across SCM providers', () => {
    const commands = [
      'workbench.scm.action.toggleRepositoryVisibility.scm1',
      'workbench.scm.action.toggleRepositoryVisibility.scm2',
    ];

    expect(discoverVisibilityCommands(1, commands)).toEqual({
      kind: 'excess',
      commandCount: 2,
    });
  });

  it('classifies missing commands as pending lazy registration', () => {
    expect(discoverVisibilityCommands(1, [])).toEqual({ kind: 'pending', commandCount: 0 });
  });
});
