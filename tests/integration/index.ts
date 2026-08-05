import { strict as assert } from 'node:assert';
import { appendFile } from 'node:fs/promises';
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

  const mappings = await api.resolveVisibilityMappings();
  assert.equal(mappings.length, 2);
  const alpha = repositoryAt(api, alphaPath);
  const beta = repositoryAt(api, betaPath);
  assert(alpha && beta);

  const alphaMapping = mappings.find(mapping => mapping.repository.rootUri.toString() === alpha.rootUri.toString());
  const betaMapping = mappings.find(mapping => mapping.repository.rootUri.toString() === beta.rootUri.toString());
  assert(alphaMapping && betaMapping);

  const before = api.git.repositories.length;
  await api.toggle(alphaMapping);
  assert.equal(api.git.repositories.length, before, 'Hiding must not remove the repository from the Git API.');

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
  assert.equal(api.git.repositories.length, before);

  await api.toggle(betaMapping);
  assert.equal(api.git.repositories.length, before, 'The last visible repository must remain monitored.');

  const visualPauseMilliseconds = Number(process.env.REPOFOCUS_VISUAL_PAUSE_MS ?? '0');
  if (visualPauseMilliseconds > 0) {
    await new Promise(resolve => setTimeout(resolve, visualPauseMilliseconds));
  }

  await api.toggle(betaMapping);
  await api.toggle(alphaMapping);
}
