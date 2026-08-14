import { describe, expect, it } from 'vitest';
import { discoverVisibilityCommands, selectionModeCommands } from '../src/visibilityCommandResolver';

/**
 * VS Code registers the selection-mode commands eagerly at startup and the
 * per-repository visibility commands only once Source Control has rendered, so
 * every realistic command list contains the siblings.
 */
const siblings = [selectionModeCommands.single, selectionModeCommands.multiple];

describe('discoverVisibilityCommands', () => {
  it('sorts native visibility commands by SCM handle', () => {
    const commands = [
      ...siblings,
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
      ...siblings,
      'workbench.scm.action.toggleRepositoryVisibility.scm1',
      'workbench.scm.action.toggleRepositoryVisibility.scm2',
    ];

    expect(discoverVisibilityCommands(1, commands)).toEqual({
      kind: 'excess',
      commandCount: 2,
    });
  });

  it('classifies missing per-repository commands as pending lazy registration', () => {
    expect(discoverVisibilityCommands(1, siblings)).toEqual({ kind: 'pending', commandCount: 0 });
  });

  it('classifies a missing selection-mode family as unsupported, not as pending', () => {
    // This break is detectable; a renamed per-repository family is not.
    expect(discoverVisibilityCommands(1, [])).toEqual({ kind: 'unsupported', commandCount: 0 });
    expect(discoverVisibilityCommands(1, [
      'workbench.scm.action.toggleRepositoryVisibility.scm0',
    ])).toEqual({ kind: 'unsupported', commandCount: 1 });
  });
});
