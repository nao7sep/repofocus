// Extension Host test for the MULTI-ROOT workspace shape: several repositories
// opened as sibling workspace folders from unrelated parent directories, rather
// than one folder containing repositories as subdirectories.
//
// Measured behaviour, recorded here because it is counter-intuitive: when a
// repository IS a workspace-folder root, `vscode.workspace.asRelativePath`
// returns the ABSOLUTE PATH unchanged — identically for `true`, `false`, and the
// default. There is no relative form to produce, so the `includeWorkspaceFolder`
// argument is inert in this shape. (It is not inert for a repository nested
// inside a multi-root folder, which is why the extension now omits the argument
// and lets VS Code's own multi-root-aware default apply.)
//
// RepoFocus therefore checks both VS Code's path value and the repository's
// directory name. This fixture uses an absolute pattern to target only one of
// two same-named roots; the unit suite separately covers portable bare-name
// fallback.

import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { GitRepository } from '../../src/gitApi';
import type { RepoFocusExtensionApi } from '../../src/extension';

const extensionId = 'nao7sep.repofocus';
const defaultWaitTimeoutMilliseconds = process.platform === 'win32' ? 60_000 : 15_000;

async function waitFor<T>(
  description: string,
  read: () => T | undefined,
  timeoutMilliseconds = defaultWaitTimeoutMilliseconds,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function repositoryAt(api: RepoFocusExtensionApi, path: string): GitRepository | undefined {
  const expected = resolve(path);
  return api.git.repositories.find(repository => {
    const actual = resolve(repository.rootUri.fsPath);
    return process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  });
}

export async function run(): Promise<void> {
  const firstRoot = process.env.REPOFOCUS_MULTIROOT_FIRST;
  const secondRoot = process.env.REPOFOCUS_MULTIROOT_SECOND;
  assert(firstRoot, 'REPOFOCUS_MULTIROOT_FIRST must identify the first workspace folder.');
  assert(secondRoot, 'REPOFOCUS_MULTIROOT_SECOND must identify the second workspace folder.');

  const extension = vscode.extensions.getExtension<RepoFocusExtensionApi>(extensionId);
  assert(extension, `${extensionId} must be installed in the Extension Host.`);
  assert.equal(extension.isActive, false, 'RepoFocus must wait for Source Control to open.');

  // Opening Source Control represents the user's pane choice, and RepoFocus can
  // map nothing until the native view registers its commands.
  await vscode.commands.executeCommand('workbench.view.scm');
  const api = await waitFor(
    'RepoFocus activation after Source Control opens',
    () => extension.isActive ? extension.exports : undefined,
  );

  // The shape itself: VS Code must actually be in a multi-root workspace, or the
  // asRelativePath default under test never engages and the run proves nothing.
  const folders = vscode.workspace.workspaceFolders ?? [];
  assert.equal(folders.length, 2, 'The fixture must open exactly two workspace folders.');

  const first = await waitFor('first repository to open', () => repositoryAt(api, firstRoot));
  const second = await waitFor('second repository to open', () => repositoryAt(api, secondRoot));

  // The path candidates alwaysShow receives from VS Code.
  const firstMatchable = vscode.workspace.asRelativePath(first.rootUri.fsPath);
  const secondMatchable = vscode.workspace.asRelativePath(second.rootUri.fsPath);
  assert.notEqual(
    firstMatchable,
    secondMatchable,
    'Repositories in different roots must be separately targetable.',
  );
  // Pin the surprise: a folder-root repository has no relative path candidate.
  // RepoFocus's directory-name candidate remains portable, while an absolute
  // pattern can still distinguish two roots that share the same directory name.
  assert.ok(
    isAbsolute(firstMatchable) && basename(firstMatchable) === 'shared',
    `A folder-root repository is matched by absolute path today, got "${firstMatchable}".`,
  );

  const configuration = vscode.workspace.getConfiguration('repofocus');

  // Both are clean, so both should be hidden before any alwaysShow pattern applies.
  const describe = (): string => JSON.stringify({
    filteringEnabled: api.isFilteringEnabled(),
    repositoryCount: api.git.repositories.length,
    first: { hidden: api.isHiddenByRepoFocus(first), actionability: api.getActionability(first) },
    second: { hidden: api.isHiddenByRepoFocus(second), actionability: api.getActionability(second) },
  });
  try {
    await waitFor('both clean repositories to be hidden', () =>
      api.isHiddenByRepoFocus(first) && api.isHiddenByRepoFocus(second) ? true : undefined,
    );
  } catch (error) {
    throw new Error(`${(error as Error).message} State: ${describe()}`, { cause: error });
  }

  // Target only the first with its absolute candidate. The payoff assertion is
  // that the same-named second repository stays hidden.
  await configuration.update('alwaysShow', [firstMatchable], vscode.ConfigurationTarget.Workspace);
  await waitFor('the targeted repository to become visible', () =>
    api.getActionability(first)?.reasons.some(reason => reason.kind === 'always-show')
      && !api.isHiddenByRepoFocus(first) ? true : undefined,
  );
  await api.waitForSettled();
  assert.equal(
    api.isHiddenByRepoFocus(second),
    true,
    'A pattern naming one workspace folder must not reveal the same-named repository in another root.',
  );

  await configuration.update('alwaysShow', [], vscode.ConfigurationTarget.Workspace);
  await waitFor('the targeted repository to become hidden again', () =>
    api.isHiddenByRepoFocus(first) ? true : undefined,
  );

  // A dirty repository in a non-first root must still surface on its own merits —
  // proving discovery spans roots, not just the folder VS Code happens to list first.
  await writeFile(join(secondRoot, 'tracked.txt'), 'multi-root change\n', 'utf8');
  await second.status();
  await waitFor('a change in the second root to reveal its repository', () =>
    !api.isHiddenByRepoFocus(second) ? true : undefined,
  );
}
