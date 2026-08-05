import { strict as assert } from 'node:assert';
import { appendFile, writeFile } from 'node:fs/promises';
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
    if (value !== undefined) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function openRepository(path: string): Promise<void> {
  await vscode.commands.executeCommand('git.openRepository', path);
}

function repositoryAt(api: RepoFocusExtensionApi, path: string): GitRepository | undefined {
  return api.git.repositories.find(repository => repository.rootUri.fsPath === path);
}

export async function run(): Promise<void> {
  const fixtureRoot = process.env.REPOFOCUS_INTEGRATION_ROOT;
  assert(fixtureRoot, 'REPOFOCUS_INTEGRATION_ROOT must identify the integration workspace.');

  const alphaPath = join(fixtureRoot, 'alpha');
  const betaPath = join(fixtureRoot, 'beta');
  await openRepository(alphaPath);
  await openRepository(betaPath);

  const extension = vscode.extensions.getExtension<RepoFocusExtensionApi>(extensionId);
  assert(extension, `Extension ${extensionId} was not loaded.`);
  const api = await extension.activate();

  await waitFor('both Git repositories', () =>
    repositoryAt(api, alphaPath) && repositoryAt(api, betaPath) ? true : undefined,
  );
  await vscode.commands.executeCommand('workbench.view.scm');
  const alpha = repositoryAt(api, alphaPath);
  const beta = repositoryAt(api, betaPath);
  assert(alpha && beta);
  await api.waitForSettled();
  const before = api.git.repositories.length;
  assert(api.isHiddenByRepoFocus(alpha), 'A clean repository must be hidden automatically.');
  assert(api.isHiddenByRepoFocus(beta), 'The last clean repository must also be hidden automatically.');
  assert.equal(api.git.repositories.length, before, 'Hiding must not remove repositories from the Git API.');

  const stateChanged = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error('Hidden repository did not emit a Git state change after an external edit.'));
    }, 15_000);
    const subscription = alpha.state.onDidChange(() => {
      if (alpha.state.workingTreeChanges.length > 0) {
        clearTimeout(timeout);
        subscription.dispose();
        resolve();
      }
    });
  });

  await appendFile(join(alphaPath, 'tracked.txt'), 'changed while hidden\n', 'utf8');
  await stateChanged;
  await api.waitForSettled();
  assert.equal(api.git.repositories.length, before);
  assert.deepEqual(
    api.getActionability(alpha)?.reasons.map(reason => reason.kind),
    ['unstaged'],
    'A hidden edit must flow into RepoFocus actionability.',
  );
  assert.equal(api.isHiddenByRepoFocus(alpha), false, 'An actionable repository must be shown again.');
  assert.equal(api.isHiddenByRepoFocus(beta), true, 'The remaining clean repository must stay hidden.');

  await vscode.commands.executeCommand('repofocus.showAll');
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(alpha), false);
  assert.equal(api.isHiddenByRepoFocus(beta), false, 'Show All Repositories must disable filtering and restore clean repositories.');

  await writeFile(join(betaPath, 'untracked.txt'), 'untracked\n', 'utf8');
  await beta.status();
  await waitFor('untracked-file actionability', () =>
    api.getActionability(beta)?.reasons.some(reason => reason.kind === 'untracked') ? true : undefined,
  );

  const configuration = vscode.workspace.getConfiguration('repofocus');
  await configuration.update('includeUntrackedFiles', false, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('repofocus.toggle');
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(alpha), false, 'The changed repository must remain visible.');
  assert.equal(api.isHiddenByRepoFocus(beta), true, 'Excluded untracked files must not make a repository visible.');

  await configuration.update('includeUntrackedFiles', true, vscode.ConfigurationTarget.Workspace);
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(beta), false, 'Changing policy must immediately reveal the newly actionable repository.');

  await writeFile(join(alphaPath, 'tracked.txt'), 'alpha\n', 'utf8');
  await alpha.status();
  await waitFor('clean repository to become hidden again', () =>
    api.getActionability(alpha)?.actionable === false && api.isHiddenByRepoFocus(alpha) ? true : undefined,
  );

  const visualPauseMilliseconds = Number(process.env.REPOFOCUS_VISUAL_PAUSE_MS ?? '0');
  if (visualPauseMilliseconds > 0) {
    await new Promise(resolve => setTimeout(resolve, visualPauseMilliseconds));
  }

  await vscode.commands.executeCommand('repofocus.showAll');
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(alpha), false);
  assert.equal(api.isHiddenByRepoFocus(beta), false);
}
