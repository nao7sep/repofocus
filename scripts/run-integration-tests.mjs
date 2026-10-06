import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const extensionDevelopmentPath = resolve(
  process.env.REPOFOCUS_INTEGRATION_EXTENSION_PATH ?? projectRoot,
);
const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
const vscodeVersion = process.env.REPOFOCUS_INTEGRATION_VSCODE_VERSION ?? '1.131.0';
const temporaryRoots = [];

async function temporaryRoot(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

function git(repositoryPath, ...args) {
  execFileSync('git', args, { cwd: repositoryPath, stdio: 'ignore' });
}

async function createRepositoryAt(repositoryPath) {
  const name = repositoryPath.split('/').pop();
  await mkdir(repositoryPath, { recursive: true });
  git(repositoryPath, 'init', '-b', 'main');
  await writeFile(join(repositoryPath, 'tracked.txt'), `${name}\n`, 'utf8');
  git(repositoryPath, 'add', 'tracked.txt');
  git(repositoryPath, 'commit', '-m', 'fixture');
}

try {
  const repositoryCount = Number(process.env.REPOFOCUS_INTEGRATION_REPOSITORY_COUNT ?? '50');
  if (!Number.isSafeInteger(repositoryCount) || repositoryCount < 4) {
    throw new Error('REPOFOCUS_INTEGRATION_REPOSITORY_COUNT must be an integer of at least 4.');
  }

  // Every Git process below, the Extension Host and its built-in Git extension
  // inherit this environment, so the developer's global and system Git
  // configuration (hooks, signing, ignores, attributes) never applies. Git finds
  // these files through its own variables, on Windows as on macOS.
  const gitConfigRoot = await temporaryRoot('repofocus-git-');
  const gitConfigPath = join(gitConfigRoot, 'config');
  process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  for (const [key, value] of [
    ['user.name', 'RepoFocus Tests'],
    ['user.email', 'repofocus-tests@example.invalid'],
    ['core.excludesFile', join(gitConfigRoot, 'ignore')],
    ['core.attributesFile', join(gitConfigRoot, 'attributes')],
  ]) {
    execFileSync('git', ['config', '--file', gitConfigPath, key, value], { stdio: 'ignore' });
  }

  const fixtureRoot = await temporaryRoot('repofocus-integration-');
  const remoteRoot = await temporaryRoot('repofocus-remotes-');
  await createRepositoryAt(join(fixtureRoot, 'alpha'));
  await createRepositoryAt(join(fixtureRoot, 'beta'));
  for (let index = 3; index <= repositoryCount; index += 1) {
    await createRepositoryAt(join(fixtureRoot, `repo-${String(index).padStart(2, '0')}`));
  }
  const alphaPath = join(fixtureRoot, 'alpha');
  const alphaRemotePath = join(remoteRoot, 'alpha.git');
  const alphaUpdaterPath = join(remoteRoot, 'alpha-updater');
  await mkdir(alphaRemotePath);
  git(alphaRemotePath, 'init', '--bare');
  git(alphaPath, 'remote', 'add', 'origin', alphaRemotePath);
  git(alphaPath, 'push', '--set-upstream', 'origin', 'main');
  git(alphaRemotePath, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  execFileSync('git', ['clone', alphaRemotePath, alphaUpdaterPath], { stdio: 'ignore' });

  await runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: vscodeVersion }),
    extensionDevelopmentPath,
    extensionTestsPath: join(projectRoot, 'dist-tests', 'integration.js'),
    extensionTestsEnv: {
      REPOFOCUS_INTEGRATION_ROOT: fixtureRoot,
      REPOFOCUS_INTEGRATION_UPDATER: alphaUpdaterPath,
      REPOFOCUS_INTEGRATION_REPOSITORY_COUNT: String(repositoryCount),
      REPOFOCUS_VISUAL_PAUSE_MS: process.env.REPOFOCUS_VISUAL_PAUSE_MS ?? '0',
    },
    launchArgs: [
      fixtureRoot,
      `--user-data-dir=${await temporaryRoot('repofocus-user-data-')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });

  // Second run: the multi-root shape. Two repositories with the SAME directory
  // name, in unrelated parent directories, opened as sibling workspace folders
  // through a .code-workspace file — the only way to put VS Code into a genuine
  // multi-root workspace, and the shape the single-folder run above cannot cover.
  // The two folders live under genuinely separate parents: the point of the
  // shape is that they share no common workspace root.
  const multiRootRoot = await temporaryRoot('repofocus-multiroot-');
  const multiRootFirst = join(multiRootRoot, 'first-parent');
  const multiRootSecond = join(multiRootRoot, 'second-parent');
  const firstMultiRootFolder = join(multiRootFirst, 'shared');
  const secondMultiRootFolder = join(multiRootSecond, 'shared');
  await createRepositoryAt(firstMultiRootFolder);
  await createRepositoryAt(secondMultiRootFolder);
  const workspaceFile = join(multiRootRoot, 'multi-root.code-workspace');
  await writeFile(
    workspaceFile,
    JSON.stringify({ folders: [{ path: firstMultiRootFolder }, { path: secondMultiRootFolder }] }, null, 2),
    'utf8',
  );

  await runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: vscodeVersion }),
    extensionDevelopmentPath,
    extensionTestsPath: join(projectRoot, 'dist-tests', 'multiRoot.js'),
    extensionTestsEnv: {
      REPOFOCUS_MULTIROOT_FIRST: firstMultiRootFolder,
      REPOFOCUS_MULTIROOT_SECOND: secondMultiRootFolder,
    },
    launchArgs: [
      workspaceFile,
      `--user-data-dir=${await temporaryRoot('repofocus-user-data-')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
} finally {
  // runTests settles only once its Extension Host has exited, so no profile
  // file is still open here, which matters on Windows.
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
}
