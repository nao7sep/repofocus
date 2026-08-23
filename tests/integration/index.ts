import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
  const expected = resolve(path);
  return api.git.repositories.find(repository => {
    const actual = resolve(repository.rootUri.fsPath);
    return process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  });
}

export async function run(): Promise<void> {
  const fixtureRoot = process.env.REPOFOCUS_INTEGRATION_ROOT;
  const updaterPath = process.env.REPOFOCUS_INTEGRATION_UPDATER;
  assert(fixtureRoot, 'REPOFOCUS_INTEGRATION_ROOT must identify the integration workspace.');
  assert(updaterPath, 'REPOFOCUS_INTEGRATION_UPDATER must identify the upstream fixture clone.');
  const expectedRepositoryCount = Number(process.env.REPOFOCUS_INTEGRATION_REPOSITORY_COUNT ?? '2');
  const initialFilteringTimeoutMilliseconds = process.platform === 'win32' ? 120_000 : 15_000;
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.workspace.getConfiguration('git').update(
    'autofetch',
    false,
    vscode.ConfigurationTarget.Workspace,
  );

  const alphaPath = join(fixtureRoot, 'alpha');
  const betaPath = join(fixtureRoot, 'beta');
  const repositoryPaths = [
    alphaPath,
    betaPath,
    ...Array.from({ length: expectedRepositoryCount - 2 }, (_, index) =>
      join(fixtureRoot, `repo-${String(index + 3).padStart(2, '0')}`)),
  ];
  const discoveryOrder = repositoryPaths.filter((_, index) => index % 2 === 0)
    .concat(repositoryPaths.filter((_, index) => index % 2 === 1).reverse());
  for (const repositoryPath of discoveryOrder) {
    await openRepository(repositoryPath);
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  const extension = vscode.extensions.getExtension<RepoFocusExtensionApi>(extensionId);
  assert(extension, `Extension ${extensionId} was not loaded.`);
  const api = await waitFor(
    'RepoFocus activation after VS Code startup',
    () => extension.isActive ? extension.exports : undefined,
    120_000,
  );

  // RepoFocus starts without changing the user's pane. Opening Source Control
  // later must let its bounded command-registration retry initialize filtering.
  await vscode.commands.executeCommand('workbench.view.scm');

  try {
    await waitFor('all Git repositories', () =>
      api.git.state === 'initialized'
        && repositoryPaths.every(path => repositoryAt(api, path))
        && api.git.repositories.length === expectedRepositoryCount ? true : undefined,
    120_000);
  } catch (error) {
    throw new Error(
      `Git discovery did not settle: state=${api.git.state} `
      + `repositoryCount=${api.git.repositories.length} expected=${expectedRepositoryCount}.`,
      { cause: error },
    );
  }
  const initialSettleStarted = Date.now();
  const alpha = repositoryAt(api, alphaPath);
  const beta = repositoryAt(api, betaPath);
  assert(alpha && beta);
  await api.waitForSettled();
  await waitFor('initial clean actionability', () =>
    repositoryPaths.every(path => {
      const repository = repositoryAt(api, path);
      return repository && api.getActionability(repository)?.actionable === false;
    }) ? true : undefined,
  );
  try {
    await waitFor('all clean repositories to become hidden', () =>
      repositoryPaths.every(path => {
        const repository = repositoryAt(api, path);
        return repository && api.getActionability(repository)?.actionable === false
          && api.isHiddenByRepoFocus(repository);
      }) ? true : undefined,
      initialFilteringTimeoutMilliseconds,
    );
  } catch (error) {
    await vscode.commands.executeCommand('repofocus.copyDiagnostics');
    const diagnosticState = await vscode.env.clipboard.readText();
    const commands = await vscode.commands.getCommands(true);
    const nativeCommandState = {
      repositoryVisibilityCommandCount: commands.filter(command =>
        command.startsWith('workbench.scm.action.toggleRepositoryVisibility.')).length,
      hasMultipleModeCommand: commands.includes(
        'workbench.scm.action.repositories.setSelectionMode.multiple',
      ),
      hasSingleModeCommand: commands.includes(
        'workbench.scm.action.repositories.setSelectionMode.single',
      ),
    };
    const state = repositoryPaths.map(path => {
      const repository = repositoryAt(api, path);
      return {
        name: path.slice(fixtureRoot.length + 1),
        hidden: repository ? api.isHiddenByRepoFocus(repository) : undefined,
        actionability: repository ? api.getActionability(repository) : undefined,
      };
    });
    throw new Error(
      `Initial state did not settle: ${JSON.stringify(state)} nativeCommands=${JSON.stringify(nativeCommandState)} diagnostics=${diagnosticState}`,
      { cause: error },
    );
  }
  assert(
    Date.now() - initialSettleStarted < initialFilteringTimeoutMilliseconds,
    `${expectedRepositoryCount}-repository initial filtering must settle within `
      + `${initialFilteringTimeoutMilliseconds / 1_000} seconds after Git discovery.`,
  );

  const before = api.git.repositories.length;
  assert.equal(before, expectedRepositoryCount);
  assert(
    api.isHiddenByRepoFocus(alpha),
    `A clean repository must be hidden automatically: ${JSON.stringify(api.getActionability(alpha))}`,
  );
  assert(api.isHiddenByRepoFocus(beta), 'The last clean repository must also be hidden automatically.');
  for (const path of repositoryPaths) {
    const repository = repositoryAt(api, path);
    assert(repository && api.isHiddenByRepoFocus(repository), `Clean repository ${path} must be hidden.`);
  }
  const configuration = vscode.workspace.getConfiguration('repofocus');
  assert.equal(api.git.repositories.length, before, 'Hiding must not remove repositories from the Git API.');
  await vscode.commands.executeCommand('repofocus.copyDiagnostics');
  const diagnostics = JSON.parse(await vscode.env.clipboard.readText()) as {
    repositoryCount?: number;
    nativeMappingState?: string;
  };
  assert.equal(
    diagnostics.repositoryCount,
    expectedRepositoryCount,
    'Copied diagnostics must summarize every monitored repository.',
  );
  assert.equal(
    diagnostics.nativeMappingState,
    'mapped',
    'Diagnostics must distinguish a mapped session from one that is merely waiting.',
  );

  await appendFile(join(updaterPath, 'tracked.txt'), 'incoming\n', 'utf8');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: updaterPath });
  execFileSync('git', ['commit', '-m', 'incoming fixture'], { cwd: updaterPath });
  execFileSync('git', ['push'], { cwd: updaterPath });
  const remoteHeadBeforeRefresh = execFileSync(
    'git',
    ['rev-parse', 'refs/remotes/origin/main'],
    { cwd: alphaPath, encoding: 'utf8' },
  ).trim();
  await vscode.commands.executeCommand('repofocus.refresh');
  await api.waitForSettled();
  const remoteHeadAfterRefresh = execFileSync(
    'git',
    ['rev-parse', 'refs/remotes/origin/main'],
    { cwd: alphaPath, encoding: 'utf8' },
  ).trim();
  assert.equal(
    remoteHeadAfterRefresh,
    remoteHeadBeforeRefresh,
    'RepoFocus Refresh must not fetch or advance remote-tracking refs.',
  );
  execFileSync('git', ['fetch'], { cwd: alphaPath });
  await alpha.status();
  await waitFor('incoming-commit actionability', () =>
    api.getActionability(alpha)?.reasons.some(reason => reason.kind === 'incoming') ? true : undefined,
  );
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(alpha), false, 'A repository with an incoming commit must become visible.');
  execFileSync('git', ['merge', '--ff-only', 'origin/main'], { cwd: alphaPath });
  await alpha.status();
  try {
    await waitFor('updated repository to become hidden', () =>
      api.getActionability(alpha)?.actionable === false && api.isHiddenByRepoFocus(alpha) ? true : undefined,
    );
  } catch (error) {
    await vscode.commands.executeCommand('repofocus.copyDiagnostics');
    throw new Error(
      `Updated repository did not hide: ${JSON.stringify(api.getActionability(alpha))} `
        + `diagnostics=${await vscode.env.clipboard.readText()}`,
      { cause: error },
    );
  }
  const cleanAlphaContents = await readFile(join(alphaPath, 'tracked.txt'), 'utf8');

  execFileSync('git', ['commit', '--allow-empty', '-m', 'outgoing fixture'], { cwd: alphaPath });
  await alpha.status();
  await waitFor('outgoing-commit actionability', () =>
    api.getActionability(alpha)?.reasons.some(reason => reason.kind === 'outgoing') ? true : undefined,
  );
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(alpha), false, 'A repository with an outgoing commit must become visible.');
  execFileSync('git', ['push'], { cwd: alphaPath });
  await alpha.status();
  await waitFor('pushed repository to become hidden', () =>
    api.getActionability(alpha)?.actionable === false && api.isHiddenByRepoFocus(alpha) ? true : undefined,
  );

  const stateChanged = new Promise<void>(resolve => {
    const subscription = alpha.state.onDidChange(() => {
      if (alpha.state.workingTreeChanges.length > 0) {
        subscription.dispose();
        resolve();
      }
    });
  });

  await appendFile(join(alphaPath, 'tracked.txt'), 'changed while hidden\n', 'utf8');
  const watcherReportedChange = await Promise.race([
    stateChanged.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!watcherReportedChange) await alpha.status();
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

  await vscode.commands.executeCommand('repofocus.toggle');
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(alpha), false);
  assert.equal(api.isHiddenByRepoFocus(beta), false, 'Show All Repositories must disable filtering and restore clean repositories.');
  for (const path of repositoryPaths) {
    const repository = repositoryAt(api, path);
    assert(repository && !api.isHiddenByRepoFocus(repository), `Show All must restore ${path}.`);
  }

  await writeFile(join(betaPath, 'untracked.txt'), 'untracked\n', 'utf8');
  await beta.status();
  await waitFor('untracked-file actionability', () =>
    api.getActionability(beta)?.reasons.some(reason => reason.kind === 'untracked') ? true : undefined,
  );

  await vscode.commands.executeCommand('repofocus.toggle');
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(alpha), false, 'The changed repository must remain visible.');
  assert.equal(api.isHiddenByRepoFocus(beta), false, 'Untracked files must make a repository visible.');

  await writeFile(join(alphaPath, 'tracked.txt'), cleanAlphaContents, 'utf8');
  await alpha.status();
  await waitFor('clean repository to become hidden again', () =>
    api.getActionability(alpha)?.actionable === false && api.isHiddenByRepoFocus(alpha) ? true : undefined,
  );

  await configuration.update('alwaysShow', ['alpha'], vscode.ConfigurationTarget.Workspace);
  await waitFor('always-show repository to become visible', () =>
    api.getActionability(alpha)?.reasons.some(reason => reason.kind === 'always-show')
      && !api.isHiddenByRepoFocus(alpha) ? true : undefined,
  );
  await configuration.update('alwaysShow', [], vscode.ConfigurationTarget.Workspace);
  await waitFor('repository removed from always-show to become hidden', () =>
    api.getActionability(alpha)?.actionable === false && api.isHiddenByRepoFocus(alpha) ? true : undefined,
  );

  await vscode.commands.executeCommand('git.close', alpha.rootUri);
  await waitFor('alpha repository to close', () => repositoryAt(api, alphaPath) ? undefined : true);
  await openRepository(alphaPath);
  const reopenedAlpha = await waitFor('alpha repository to reopen', () => repositoryAt(api, alphaPath));
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), true, 'A clean repository reopened after activation must be hidden.');

  const visualPauseMilliseconds = Number(process.env.REPOFOCUS_VISUAL_PAUSE_MS ?? '0');
  if (visualPauseMilliseconds > 0) {
    await configuration.update('alwaysShow', ['alpha'], vscode.ConfigurationTarget.Workspace);
    await waitFor('visual fixture repositories to become visible', () =>
      !api.isHiddenByRepoFocus(reopenedAlpha) && !api.isHiddenByRepoFocus(beta) ? true : undefined,
    );
    await new Promise(resolve => setTimeout(resolve, visualPauseMilliseconds));
    await configuration.update('alwaysShow', [], vscode.ConfigurationTarget.Workspace);
  }

  await vscode.commands.executeCommand('repofocus.toggle');
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), false);
  assert.equal(api.isHiddenByRepoFocus(beta), false);

  await vscode.commands.executeCommand('repofocus.toggle');
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), true, 'The clean repository must hide when filtering resumes.');
  assert.equal(api.isHiddenByRepoFocus(beta), false, 'The actionable repository must remain visible when filtering resumes.');

  // The headline safety property: RepoFocus reaches and keeps a filtered view
  // without ever writing VS Code's own configuration.
  const selectionMode = vscode.workspace.getConfiguration('scm')
    .inspect<string>('repositories.selectionMode');
  assert.equal(
    selectionMode?.globalValue,
    undefined,
    'RepoFocus must never write scm.repositories.selectionMode to user settings.',
  );
  assert.equal(
    selectionMode?.workspaceValue,
    undefined,
    'RepoFocus must never write scm.repositories.selectionMode to workspace settings.',
  );

  await api.shutdown();
  await api.shutdown();
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), false, 'Deactivation must restore repositories hidden by RepoFocus.');
  assert.equal(api.git.repositories.length, expectedRepositoryCount, 'Deactivation must not close Git repositories.');
}
