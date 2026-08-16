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
// The consequence is a real gap, tracked in the release plan rather than
// asserted away here: `repofocus.alwaysShow` is documented as taking
// "workspace-relative" globs, but in this shape only an ABSOLUTE pattern can
// match, and absolute patterns are machine-specific. This test pins the
// behaviour that exists today so the gap cannot close by accident unnoticed.
//
// Both fixture repositories are deliberately named `shared`, so any matching
// that fell back to a bare directory name would reveal both and fail here.

import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { GitRepository } from '../../src/gitApi';
import type { RepoFocusExtensionApi } from '../../src/extension';

const extensionId = 'nao7sep.repofocus';

async function waitFor<T>(
  description: string,
  read: () => T | undefined,
  timeoutMilliseconds = 15_000,
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
  return api.git.repositories.find(repository => repository.rootUri.fsPath === path);
}

export async function run(): Promise<void> {
  const firstRoot = process.env.REPOFOCUS_MULTIROOT_FIRST;
  const secondRoot = process.env.REPOFOCUS_MULTIROOT_SECOND;
  assert(firstRoot, 'REPOFOCUS_MULTIROOT_FIRST must identify the first workspace folder.');
  assert(secondRoot, 'REPOFOCUS_MULTIROOT_SECOND must identify the second workspace folder.');

  const extension = vscode.extensions.getExtension<RepoFocusExtensionApi>(extensionId);
  assert(extension, `${extensionId} must be installed in the Extension Host.`);
  const api = await extension.activate();

  // The shape itself: VS Code must actually be in a multi-root workspace, or the
  // asRelativePath default under test never engages and the run proves nothing.
  const folders = vscode.workspace.workspaceFolders ?? [];
  assert.equal(folders.length, 2, 'The fixture must open exactly two workspace folders.');

  const first = await waitFor('first repository to open', () => repositoryAt(api, firstRoot));
  const second = await waitFor('second repository to open', () => repositoryAt(api, secondRoot));

  // Opening Source Control represents the user's pane choice, and RepoFocus can
  // map nothing until the native view registers its commands (it stands down as
  // 'awaiting-native-commands' otherwise). RepoFocus must not issue this itself.
  await vscode.commands.executeCommand('workbench.view.scm');

  // The strings alwaysShow actually matches against, computed exactly as the
  // extension computes them.
  const firstMatchable = vscode.workspace.asRelativePath(first.rootUri.fsPath);
  const secondMatchable = vscode.workspace.asRelativePath(second.rootUri.fsPath);
  assert.notEqual(
    firstMatchable,
    secondMatchable,
    'Repositories in different roots must be separately targetable.',
  );
  // Pin the surprise: a folder-root repository has no relative form, so both
  // repositories are addressed by absolute path even though the setting is
  // documented as workspace-relative. If VS Code ever starts returning a real relative
  // form here, this fails and the documented contract can be revisited.
  assert.ok(
    firstMatchable.startsWith('/') && firstMatchable.endsWith('/shared'),
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

  // Target ONLY the first. The payoff assertion is the second staying hidden —
  // both directories are named `shared`, so any matching that degraded to a bare
  // directory name would reveal both and fail here.
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
