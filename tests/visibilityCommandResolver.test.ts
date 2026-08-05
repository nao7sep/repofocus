import { describe, expect, it } from 'vitest';
import {
  resolveVisibilityCommands,
  VisibilityCompatibilityError,
} from '../src/visibilityCommandResolver';

function repository(uri: string) {
  return { rootUri: { toString: () => uri } };
}

describe('resolveVisibilityCommands', () => {
  it('maps repository creation order to native SCM handle order', () => {
    const repositories = [repository('file:///alpha'), repository('file:///beta')];
    const commands = [
      'unrelated.command',
      'workbench.scm.action.toggleRepositoryVisibility.scm7',
      'workbench.scm.action.toggleRepositoryVisibility.scm6',
    ];

    expect(resolveVisibilityCommands(repositories, commands)).toEqual([
      { repository: repositories[0], command: 'workbench.scm.action.toggleRepositoryVisibility.scm6' },
      { repository: repositories[1], command: 'workbench.scm.action.toggleRepositoryVisibility.scm7' },
    ]);
  });

  it('rejects another SCM provider instead of guessing', () => {
    const repositories = [repository('file:///alpha')];
    const commands = [
      'workbench.scm.action.toggleRepositoryVisibility.scm1',
      'workbench.scm.action.toggleRepositoryVisibility.scm2',
    ];

    expect(() => resolveVisibilityCommands(repositories, commands)).toThrow(VisibilityCompatibilityError);
  });

  it('rejects missing native commands', () => {
    expect(() => resolveVisibilityCommands([repository('file:///alpha')], [])).toThrow(
      VisibilityCompatibilityError,
    );
  });
});
