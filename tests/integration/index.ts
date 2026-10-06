import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { ActionabilityReason } from '../../src/actionability';
import type { GitRepository } from '../../src/gitApi';
import type { RepoFocusExtensionApi } from '../../src/extension';

const extensionId = 'nao7sep.repofocus';
const defaultWaitTimeoutMilliseconds = 15_000;

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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Runs a Git command that must stop on a conflict, which Git reports by exiting non-zero. */
function gitStoppingOnConflict(cwd: string, ...args: string[]): void {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  } catch {
    return;
  }
  throw new Error(`git ${args.join(' ')} was expected to stop on a conflict.`);
}

async function expectShownFor(
  api: RepoFocusExtensionApi,
  repository: GitRepository,
  kind: ActionabilityReason['kind'],
  description: string,
): Promise<void> {
  await repository.status();
  await waitFor(description, () =>
    api.getActionability(repository)?.reasons.some(reason => reason.kind === kind) ? true : undefined,
  );
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(repository), false, `${description}: the repository must be visible.`);
}

async function expectHidden(
  api: RepoFocusExtensionApi,
  repository: GitRepository,
  description: string,
): Promise<void> {
  await repository.status();
  await waitFor(description, () =>
    api.getActionability(repository)?.actionable === false && api.isHiddenByRepoFocus(repository)
      ? true : undefined,
  );
}

export async function run(): Promise<void> {
  const fixtureRoot = process.env.REPOFOCUS_INTEGRATION_ROOT;
  const updaterPath = process.env.REPOFOCUS_INTEGRATION_UPDATER;
  assert(fixtureRoot, 'REPOFOCUS_INTEGRATION_ROOT must identify the integration workspace.');
  assert(updaterPath, 'REPOFOCUS_INTEGRATION_UPDATER must identify the upstream fixture clone.');
  const expectedRepositoryCount = Number(process.env.REPOFOCUS_INTEGRATION_REPOSITORY_COUNT ?? '4');
  assert(expectedRepositoryCount >= 4, 'The fixture needs alpha, beta, repo-03 and repo-04.');
  const initialFilteringTimeoutMilliseconds = 15_000;
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
  const diagnosticsText = await vscode.env.clipboard.readText();
  for (const forbidden of [basename(fixtureRoot), basename(dirname(updaterPath)), 'alpha', 'beta', 'tracked.txt', 'refs/', '"main"']) {
    assert(
      !diagnosticsText.includes(forbidden),
      `Copied diagnostics must not contain repository paths, names, file names or branch names; found "${forbidden}".`,
    );
  }
  const diagnostics = JSON.parse(diagnosticsText) as {
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
  let reopenedAlpha = await waitFor('alpha repository to reopen', () => repositoryAt(api, alphaPath));
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), true, 'A clean repository reopened after activation must be hidden.');

  // Every other condition the README lists as keeping a repository visible, and
  // every state it says stays hidden, through VS Code's real Git reporting.
  const repo03Path = join(fixtureRoot, 'repo-03');
  const repo03 = repositoryAt(api, repo03Path);
  assert(repo03, 'The fixture must include repo-03.');

  await writeFile(join(repo03Path, 'staged.txt'), 'staged\n', 'utf8');
  git(repo03Path, 'add', 'staged.txt');
  await expectShownFor(api, repo03, 'staged', 'staged-change actionability');
  git(repo03Path, 'reset', '--hard', '-q');
  await expectHidden(api, repo03, 'repository with its staged change removed to become hidden');

  git(repo03Path, 'checkout', '-q', '-b', 'other');
  await writeFile(join(repo03Path, 'tracked.txt'), 'other side\n', 'utf8');
  git(repo03Path, 'commit', '-q', '-am', 'other side');
  git(repo03Path, 'checkout', '-q', 'main');
  await writeFile(join(repo03Path, 'tracked.txt'), 'main side\n', 'utf8');
  git(repo03Path, 'commit', '-q', '-am', 'main side');
  gitStoppingOnConflict(repo03Path, 'merge', 'other');
  await expectShownFor(api, repo03, 'conflicts', 'merge-conflict actionability');
  git(repo03Path, 'merge', '--abort');
  await expectHidden(api, repo03, 'repository with its merge aborted to become hidden');

  git(repo03Path, 'checkout', '-q', 'other');
  gitStoppingOnConflict(repo03Path, 'rebase', 'main');
  await expectShownFor(api, repo03, 'rebase', 'rebase-in-progress actionability');
  git(repo03Path, 'rebase', '--abort');

  // A local-only branch in a repository with no remote is not work by itself.
  await repo03.status();
  await waitFor('repo-03 to report its local-only branch', () =>
    repo03.state.HEAD?.name === 'other' ? true : undefined);
  await expectHidden(api, repo03, 'a local-only branch to stay hidden');
  git(repo03Path, 'checkout', '-q', 'main');
  await expectHidden(api, repo03, 'repo-03 back on main to stay hidden');

  // A named branch with no upstream is unpublished work once the repository has a remote.
  git(alphaPath, 'checkout', '-q', '-b', 'feature');
  await expectShownFor(api, reopenedAlpha, 'unpublished', 'unpublished-branch actionability');
  git(alphaPath, 'checkout', '-q', 'main');
  git(alphaPath, 'branch', '-q', '-D', 'feature');
  await expectHidden(api, reopenedAlpha, 'alpha back on its published branch to become hidden');

  git(alphaPath, 'checkout', '-q', '--detach');
  await reopenedAlpha.status();
  await waitFor('alpha to report a detached HEAD', () =>
    reopenedAlpha.state.HEAD && !reopenedAlpha.state.HEAD.name ? true : undefined);
  await expectHidden(api, reopenedAlpha, 'a detached HEAD to stay hidden');
  git(alphaPath, 'checkout', '-q', 'main');
  await expectHidden(api, reopenedAlpha, 'alpha back on main to stay hidden');

  const unbornPath = join(fixtureRoot, 'unborn');
  await mkdir(unbornPath);
  git(unbornPath, 'init', '-q', '-b', 'main');
  await openRepository(unbornPath);
  const unborn = await waitFor('the unborn repository to open', () => repositoryAt(api, unbornPath));
  await api.waitForSettled();
  await expectHidden(api, unborn, 'an unborn repository to stay hidden');
  await vscode.commands.executeCommand('git.close', unborn.rootUri);
  await waitFor('the unborn repository to close', () => repositoryAt(api, unbornPath) ? undefined : true);
  await api.waitForSettled();
  await expectHidden(api, reopenedAlpha, 'alpha to stay hidden after the topology change');
  assert.equal(api.isHiddenByRepoFocus(beta), false, 'beta, still holding an untracked file, must stay visible.');

  // A glob pattern, not only a bare name.
  const globMatched = repositoryPaths.filter(path => /^repo-0\d$/.test(basename(path)));
  assert(globMatched.length >= 2, 'The glob fixture needs at least repo-03 and repo-04.');
  await configuration.update('alwaysShow', ['repo-0*'], vscode.ConfigurationTarget.Workspace);
  await waitFor('every repository matching repo-0* to become visible', () =>
    globMatched.every(path => {
      const repository = repositoryAt(api, path);
      return repository
        && api.getActionability(repository)?.reasons.some(reason => reason.kind === 'always-show')
        && !api.isHiddenByRepoFocus(repository);
    }) ? true : undefined,
  );
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), true, 'A repository the glob does not match must stay hidden.');
  await configuration.update('alwaysShow', [], vscode.ConfigurationTarget.Workspace);
  await waitFor('repositories released from the glob to become hidden', () =>
    globMatched.every(path => {
      const repository = repositoryAt(api, path);
      return repository && api.isHiddenByRepoFocus(repository);
    }) ? true : undefined,
  );

  // A mapping already made stays valid when a non-Git provider appears, because
  // each Git repository keeps its own native command. The next mapping, after a
  // repository opens or closes, cannot tell the providers apart, so RepoFocus
  // stands down and shows every repository; Refresh resumes once it is gone.
  const otherProvider = vscode.scm.createSourceControl(
    'repofocus-integration',
    'Non-Git provider',
    vscode.Uri.file(fixtureRoot),
  );
  otherProvider.createResourceGroup('changes', 'Changes');
  // RepoFocus recognizes another provider by VS Code's per-repository visibility
  // commands, so Refresh is meaningful only once VS Code has registered the new one.
  const visibilityCommandCount = async (): Promise<number> =>
    (await vscode.commands.getCommands(true))
      .filter(command => command.startsWith('workbench.scm.action.toggleRepositoryVisibility.')).length;
  const registrationDeadline = Date.now() + defaultWaitTimeoutMilliseconds;
  while (await visibilityCommandCount() <= api.git.repositories.length) {
    if (Date.now() > registrationDeadline) {
      throw new Error('Timed out waiting for VS Code to register the non-Git provider\'s visibility command.');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await vscode.commands.executeCommand('repofocus.refresh');
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), true, 'An existing mapping must keep filtering beside a non-Git provider.');
  await vscode.commands.executeCommand('git.close', reopenedAlpha.rootUri);
  await waitFor('alpha to close beside the non-Git provider', () => repositoryAt(api, alphaPath) ? undefined : true);
  await openRepository(alphaPath);
  reopenedAlpha = await waitFor('alpha to reopen beside the non-Git provider', () => repositoryAt(api, alphaPath));
  await waitFor('RepoFocus to stand down beside a non-Git provider', () =>
    api.getActionability(reopenedAlpha) && !api.isHiddenByRepoFocus(reopenedAlpha) ? true : undefined,
  );
  await api.waitForSettled();
  await vscode.commands.executeCommand('repofocus.copyDiagnostics');
  assert.equal(
    (JSON.parse(await vscode.env.clipboard.readText()) as { nativeMappingState?: string }).nativeMappingState,
    'other-scm-providers',
    'Diagnostics must name the non-Git provider as the reason filtering paused.',
  );
  otherProvider.dispose();
  await vscode.commands.executeCommand('repofocus.refresh');
  await waitFor('filtering to resume once the non-Git provider is gone', () =>
    api.isHiddenByRepoFocus(reopenedAlpha) ? true : undefined,
  );
  await api.waitForSettled();

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

  // Every reset in this run returned the selection mode to its default, so no
  // user or workspace value for it remains.
  const selectionMode = vscode.workspace.getConfiguration('scm')
    .inspect<string>('repositories.selectionMode');
  assert.equal(
    selectionMode?.globalValue,
    undefined,
    'Visibility resets must leave no user value for scm.repositories.selectionMode.',
  );
  assert.equal(
    selectionMode?.workspaceValue,
    undefined,
    'Visibility resets must leave no workspace value for scm.repositories.selectionMode.',
  );

  await api.shutdown();
  await api.shutdown();
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), false, 'Deactivation must restore repositories hidden by RepoFocus.');
  assert.equal(api.git.repositories.length, expectedRepositoryCount, 'Deactivation must not close Git repositories.');
}
