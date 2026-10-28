import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { ActionabilityReason } from '../../src/actionability';
import type { DisposableLike, GitApi, GitExtensionExports, GitRepository } from '../../src/gitApi';
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
async function whenSettled<T>(
  api: RepoFocusExtensionApi,
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  for (;;) {
    const next = nextHostChange(api.git);
    try {
      await api.waitForSettled();
      const value = await read();
      if (value !== undefined) return value;
      await next.changed;
    } finally {
      next.dispose();
    }
  }
}

/**
 * Polls where progress has no host event: VS Code reports no command
 * registration, and RepoFocus retries a missing native command on its own timer.
 */
async function poll<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function openRepository(path: string): Promise<void> {
  await vscode.commands.executeCommand('git.openRepository', path);
}

function repositoryAt(api: RepoFocusExtensionApi, path: string): GitRepository | undefined {
  return gitRepositoryAt(api.git, path);
}

function gitRepositoryAt(git: GitApi, path: string): GitRepository | undefined {
  const expected = resolve(path);
  return git.repositories.find(repository => {
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
  await whenSettled(api, () =>
    api.getActionability(repository)?.reasons.some(reason => reason.kind === kind) ? true : undefined,
  );
  assert.equal(api.isHiddenByRepoFocus(repository), false, `${description}: the repository must be visible.`);
}

async function expectHidden(
  api: RepoFocusExtensionApi,
  repository: GitRepository,
): Promise<void> {
  await repository.status();
  await whenSettled(api, () =>
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
  const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  assert(gitExtension, 'The built-in Git extension was not loaded.');
  const gitApi = (await gitExtension.activate()).getAPI(1);
  for (const repositoryPath of discoveryOrder) {
    await openRepository(repositoryPath);
    // Each repository is open before the next starts, so providers register in this order.
    while (!gitRepositoryAt(gitApi, repositoryPath)) {
      await new Promise<void>(resolve => {
        const subscription = gitApi.onDidOpenRepository(() => { subscription.dispose(); resolve(); });
      });
    }
  }
  const extension = vscode.extensions.getExtension<RepoFocusExtensionApi>(extensionId);
  assert(extension, `Extension ${extensionId} was not loaded.`);
  const api = await extension.activate();

  // RepoFocus starts without changing the user's pane. Opening Source Control
  // later must let its bounded command-registration retry initialize filtering.
  await vscode.commands.executeCommand('workbench.view.scm');

  await whenSettled(api, () =>
    api.git.state === 'initialized'
      && repositoryPaths.every(path => repositoryAt(api, path))
      && api.git.repositories.length === expectedRepositoryCount ? true : undefined,
  );
  const alpha = repositoryAt(api, alphaPath);
  const beta = repositoryAt(api, betaPath);
  assert(alpha && beta);
  await whenSettled(api, () =>
    repositoryPaths.every(path => {
      const repository = repositoryAt(api, path);
      return repository && api.getActionability(repository)?.actionable === false;
    }) ? true : undefined,
  );
  // Filtering starts on RepoFocus's own retry once Source Control registers its commands.
  await poll(() =>
    repositoryPaths.every(path => {
      const repository = repositoryAt(api, path);
      return repository && api.getActionability(repository)?.actionable === false
        && api.isHiddenByRepoFocus(repository);
    }) ? true : undefined,
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
  await whenSettled(api, () =>
    api.getActionability(alpha)?.reasons.some(reason => reason.kind === 'incoming') ? true : undefined,
  );
  assert.equal(api.isHiddenByRepoFocus(alpha), false, 'A repository with an incoming commit must become visible.');
  execFileSync('git', ['merge', '--ff-only', 'origin/main'], { cwd: alphaPath });
  await expectHidden(api, alpha);
  const cleanAlphaContents = await readFile(join(alphaPath, 'tracked.txt'), 'utf8');

  execFileSync('git', ['commit', '--allow-empty', '-m', 'outgoing fixture'], { cwd: alphaPath });
  await alpha.status();
  await whenSettled(api, () =>
    api.getActionability(alpha)?.reasons.some(reason => reason.kind === 'outgoing') ? true : undefined,
  );
  assert.equal(api.isHiddenByRepoFocus(alpha), false, 'A repository with an outgoing commit must become visible.');
  execFileSync('git', ['push'], { cwd: alphaPath });
  await expectHidden(api, alpha);

  const stateChanged = new Promise<void>(resolve => {
    const subscription = alpha.state.onDidChange(() => {
      if (alpha.state.workingTreeChanges.length > 0) {
        subscription.dispose();
        resolve();
      }
    });
  });

  await appendFile(join(alphaPath, 'tracked.txt'), 'changed while hidden\n', 'utf8');
  // Git's file watcher may report the edit first; a status read reports it either way.
  await alpha.status();
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
  await whenSettled(api, () =>
    api.getActionability(beta)?.reasons.some(reason => reason.kind === 'untracked') ? true : undefined,
  );

  await vscode.commands.executeCommand('repofocus.toggle');
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(alpha), false, 'The changed repository must remain visible.');
  assert.equal(api.isHiddenByRepoFocus(beta), false, 'Untracked files must make a repository visible.');

  await writeFile(join(alphaPath, 'tracked.txt'), cleanAlphaContents, 'utf8');
  await expectHidden(api, alpha);

  await configuration.update('alwaysShow', ['alpha'], vscode.ConfigurationTarget.Workspace);
  await whenSettled(api, () =>
    api.getActionability(alpha)?.reasons.some(reason => reason.kind === 'always-show')
      && !api.isHiddenByRepoFocus(alpha) ? true : undefined,
  );
  await configuration.update('alwaysShow', [], vscode.ConfigurationTarget.Workspace);
  await whenSettled(api, () =>
    api.getActionability(alpha)?.actionable === false && api.isHiddenByRepoFocus(alpha) ? true : undefined,
  );

  // alwaysShow ignores case on every platform, including case-sensitive Linux.
  // Refresh rereads the setting, so the outcome does not race the change event.
  await configuration.update('alwaysShow', ['Alpha'], vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('repofocus.refresh');
  assert.equal(
    api.getActionability(alpha)?.reasons.some(reason => reason.kind === 'always-show') ?? false,
    true,
    `The pattern Alpha must match repository alpha on ${process.platform}.`,
  );
  assert.equal(api.isHiddenByRepoFocus(alpha), false);
  await configuration.update('alwaysShow', [], vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('repofocus.refresh');
  assert.equal(api.isHiddenByRepoFocus(alpha), true, 'Removing the pattern must hide the clean repository again.');

  await vscode.commands.executeCommand('git.close', alpha.rootUri);
  await whenSettled(api, () => repositoryAt(api, alphaPath) ? undefined : true);
  await openRepository(alphaPath);
  let reopenedAlpha = await whenSettled(api, () => repositoryAt(api, alphaPath));
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), true, 'A clean repository reopened after activation must be hidden.');

  // Every other condition that keeps a repository visible, and every state that
  // stays hidden, through VS Code's real Git reporting.
  const repo03Path = join(fixtureRoot, 'repo-03');
  const repo03 = repositoryAt(api, repo03Path);
  assert(repo03, 'The fixture must include repo-03.');

  await writeFile(join(repo03Path, 'staged.txt'), 'staged\n', 'utf8');
  git(repo03Path, 'add', 'staged.txt');
  await expectShownFor(api, repo03, 'staged', 'staged-change actionability');
  git(repo03Path, 'reset', '--hard', '-q');
  await expectHidden(api, repo03);

  git(repo03Path, 'checkout', '-q', '-b', 'other');
  await writeFile(join(repo03Path, 'tracked.txt'), 'other side\n', 'utf8');
  git(repo03Path, 'commit', '-q', '-am', 'other side');
  git(repo03Path, 'checkout', '-q', 'main');
  await writeFile(join(repo03Path, 'tracked.txt'), 'main side\n', 'utf8');
  git(repo03Path, 'commit', '-q', '-am', 'main side');
  gitStoppingOnConflict(repo03Path, 'merge', 'other');
  await expectShownFor(api, repo03, 'conflicts', 'merge-conflict actionability');
  git(repo03Path, 'merge', '--abort');
  await expectHidden(api, repo03);

  git(repo03Path, 'checkout', '-q', 'other');
  gitStoppingOnConflict(repo03Path, 'rebase', 'main');
  await expectShownFor(api, repo03, 'rebase', 'rebase-in-progress actionability');
  git(repo03Path, 'rebase', '--abort');

  // A local-only branch in a repository with no remote is not work by itself.
  await repo03.status();
  await whenSettled(api, () =>
    repo03.state.HEAD?.name === 'other' ? true : undefined);
  await expectHidden(api, repo03);
  git(repo03Path, 'checkout', '-q', 'main');
  await expectHidden(api, repo03);

  // A named branch with no upstream is unpublished work once the repository has a remote.
  git(alphaPath, 'checkout', '-q', '-b', 'feature');
  await expectShownFor(api, reopenedAlpha, 'unpublished', 'unpublished-branch actionability');
  git(alphaPath, 'checkout', '-q', 'main');
  git(alphaPath, 'branch', '-q', '-D', 'feature');
  await expectHidden(api, reopenedAlpha);

  git(alphaPath, 'checkout', '-q', '--detach');
  await reopenedAlpha.status();
  await whenSettled(api, () =>
    reopenedAlpha.state.HEAD && !reopenedAlpha.state.HEAD.name ? true : undefined);
  await expectHidden(api, reopenedAlpha);
  git(alphaPath, 'checkout', '-q', 'main');
  await expectHidden(api, reopenedAlpha);

  const unbornPath = join(fixtureRoot, 'unborn');
  await mkdir(unbornPath);
  git(unbornPath, 'init', '-q', '-b', 'main');
  await openRepository(unbornPath);
  const unborn = await whenSettled(api, () => repositoryAt(api, unbornPath));
  await expectHidden(api, unborn);
  await vscode.commands.executeCommand('git.close', unborn.rootUri);
  await whenSettled(api, () => repositoryAt(api, unbornPath) ? undefined : true);
  await expectHidden(api, reopenedAlpha);
  assert.equal(api.isHiddenByRepoFocus(beta), false, 'beta, still holding an untracked file, must stay visible.');

  // A glob pattern, not only a bare name.
  const globMatched = repositoryPaths.filter(path => /^repo-0\d$/.test(basename(path)));
  assert(globMatched.length >= 2, 'The glob fixture needs at least repo-03 and repo-04.');
  await configuration.update('alwaysShow', ['repo-0*'], vscode.ConfigurationTarget.Workspace);
  await whenSettled(api, () =>
    globMatched.every(path => {
      const repository = repositoryAt(api, path);
      return repository
        && api.getActionability(repository)?.reasons.some(reason => reason.kind === 'always-show')
        && !api.isHiddenByRepoFocus(repository);
    }) ? true : undefined,
  );
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), true, 'A repository the glob does not match must stay hidden.');
  await configuration.update('alwaysShow', [], vscode.ConfigurationTarget.Workspace);
  await whenSettled(api, () =>
    globMatched.every(path => {
      const repository = repositoryAt(api, path);
      return repository && api.isHiddenByRepoFocus(repository);
    }) ? true : undefined,
  );
  // The batch that hid them may still be hiding later repositories, alpha among
  // them; let it finish so stand-down is judged against settled visibility.
  await api.waitForSettled();

  // A mixed-provider window stands down before any global reset. Existing
  // visibility remains unchanged; Refresh resumes once the foreign provider leaves.
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
  await poll(async () => await visibilityCommandCount() > api.git.repositories.length ? true : undefined);
  await vscode.commands.executeCommand('repofocus.refresh');
  await api.waitForSettled();
  assert.equal(api.isHiddenByRepoFocus(reopenedAlpha), true, 'Stand-down must not reset existing hidden Git repositories.');
  await vscode.commands.executeCommand('git.close', reopenedAlpha.rootUri);
  await whenSettled(api, () => repositoryAt(api, alphaPath) ? undefined : true);
  await openRepository(alphaPath);
  reopenedAlpha = await whenSettled(api, () => repositoryAt(api, alphaPath));
  await whenSettled(api, () =>
    api.getActionability(reopenedAlpha) && !api.isHiddenByRepoFocus(reopenedAlpha) ? true : undefined,
  );
  // A newly opened repository is provisionally visible before its native
  // command registers. That is not evidence of the non-Git stand-down yet;
  // observe the actual reason after the automatic registration retry.
  await poll(async () => {
    await vscode.commands.executeCommand('repofocus.copyDiagnostics');
    const diagnostics = JSON.parse(await vscode.env.clipboard.readText()) as { nativeMappingState?: string };
    return diagnostics.nativeMappingState === 'other-scm-providers' ? true : undefined;
  });
  otherProvider.dispose();
  await vscode.commands.executeCommand('repofocus.refresh');
  await whenSettled(api, () => api.isHiddenByRepoFocus(reopenedAlpha) ? true : undefined);

  const visualPauseMilliseconds = Number(process.env.REPOFOCUS_VISUAL_PAUSE_MS ?? '0');
  if (visualPauseMilliseconds > 0) {
    await configuration.update('alwaysShow', ['alpha'], vscode.ConfigurationTarget.Workspace);
    await whenSettled(api, () =>
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

}
