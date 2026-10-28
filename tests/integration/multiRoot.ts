// Extension Host test for the MULTI-ROOT workspace shape: several repositories
// opened as sibling workspace folders from unrelated parent directories, rather
// than one folder containing repositories as subdirectories.
//
// Measured behaviour, recorded here because it is counter-intuitive: when a
// repository IS a workspace-folder root, `vscode.workspace.asRelativePath`
// returns the ABSOLUTE PATH unchanged — identically for `true`, `false`, and the
// default. There is no relative form to produce, so the `includeWorkspaceFolder`
// argument is inert in this shape. (It is not inert for a repository nested
// inside a multi-root folder, so the extension omits the argument and uses
// VS Code's own multi-root-aware default.)
//
// RepoFocus therefore checks both VS Code's path value and the repository's
// directory name. This fixture uses an absolute pattern to target only one of
// two same-named roots; the unit suite separately covers portable bare-name
// fallback.

import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { DisposableLike, GitApi, GitRepository } from '../../src/gitApi';
import type { RepoFocusExtensionApi } from '../../src/extension';

const extensionId = 'nao7sep.repofocus';

/** Resolves on the next Git topology, repository-state or configuration change VS Code reports. */
function nextHostChange(git: GitApi): { readonly changed: Promise<void> } & DisposableLike {
  let fire!: () => void;
  const changed = new Promise<void>(resolve => { fire = resolve; });
  const subscriptions = [
    git.onDidChangeState(fire),
    git.onDidOpenRepository(fire),
    git.onDidCloseRepository(fire),
    ...git.repositories.map(repository => repository.state.onDidChange(fire)),
    vscode.workspace.onDidChangeConfiguration(fire),
  ];
  return { changed, dispose: () => subscriptions.forEach(subscription => subscription.dispose()) };
}

/**
 * Reads once RepoFocus has settled, and again after each change VS Code reports,
 * until the read returns a value. It subscribes before each read, so a change
 * that lands while RepoFocus settles is never missed.
 */
async function whenSettled<T>(api: RepoFocusExtensionApi, read: () => T | undefined): Promise<T> {
  for (;;) {
    const next = nextHostChange(api.git);
    try {
      await api.waitForSettled();
      const value = read();
      if (value !== undefined) return value;
      await next.changed;
    } finally {
      next.dispose();
    }
  }
}

/** Polls where progress has no host event: RepoFocus retries a missing native command on its own timer. */
async function poll<T>(read: () => T | undefined): Promise<T> {
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
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
  const api = await extension.activate();

  // RepoFocus starts without changing the user's pane, then initializes when
  // the native view registers its commands.
  await vscode.commands.executeCommand('workbench.view.scm');

  // The shape itself: VS Code must actually be in a multi-root workspace, or the
  // asRelativePath default under test never engages and the run proves nothing.
  const folders = vscode.workspace.workspaceFolders ?? [];
  assert.equal(folders.length, 2, 'The fixture must open exactly two workspace folders.');

  const first = await whenSettled(api, () => repositoryAt(api, firstRoot));
  const second = await whenSettled(api, () => repositoryAt(api, secondRoot));

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
  // Filtering starts on RepoFocus's own retry once Source Control registers its commands.
  await poll(() => api.isHiddenByRepoFocus(first) && api.isHiddenByRepoFocus(second) ? true : undefined);

  // Target only the first with its absolute candidate. The payoff assertion is
  // that the same-named second repository stays hidden.
  await configuration.update('alwaysShow', [firstMatchable], vscode.ConfigurationTarget.Workspace);
  await whenSettled(api, () =>
    api.getActionability(first)?.reasons.some(reason => reason.kind === 'always-show')
      && !api.isHiddenByRepoFocus(first) ? true : undefined,
  );
  assert.equal(
    api.isHiddenByRepoFocus(second),
    true,
    'A pattern naming one workspace folder must not reveal the same-named repository in another root.',
  );

  await configuration.update('alwaysShow', [], vscode.ConfigurationTarget.Workspace);
  await whenSettled(api, () =>
    api.isHiddenByRepoFocus(first) ? true : undefined,
  );

  // A dirty repository in a non-first root must still surface on its own merits —
  // proving discovery spans roots, not just the folder VS Code happens to list first.
  await writeFile(join(secondRoot, 'tracked.txt'), 'multi-root change\n', 'utf8');
  await second.status();
  await whenSettled(api, () =>
    !api.isHiddenByRepoFocus(second) ? true : undefined,
  );
}
