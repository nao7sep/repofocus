import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtureRoot = await mkdtemp(join(tmpdir(), 'repofocus-integration-'));
const remoteRoot = await mkdtemp(join(tmpdir(), 'repofocus-remotes-'));
// The multi-root fixture's two folders must live under genuinely separate
// parents — the point of the shape is that they share no common workspace root.
const multiRootRoot = await mkdtemp(join(tmpdir(), 'repofocus-multiroot-'));
const multiRootFirst = join(multiRootRoot, 'first-parent');
const multiRootSecond = join(multiRootRoot, 'second-parent');
const configuredVscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
const localVscodeExecutablePath = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const vscodeExecutablePath = configuredVscodeExecutablePath
  ?? (existsSync(localVscodeExecutablePath) ? localVscodeExecutablePath : undefined);

function git(repositoryPath, ...args) {
  execFileSync('git', args, { cwd: repositoryPath, stdio: 'ignore' });
}

async function createRepository(name) {
  await createRepositoryAt(join(fixtureRoot, name));
}

async function createRepositoryAt(repositoryPath) {
  const name = repositoryPath.split('/').pop();
  await mkdir(repositoryPath, { recursive: true });
  git(repositoryPath, 'init', '-b', 'main');
  git(repositoryPath, 'config', 'user.name', 'RepoFocus Tests');
  git(repositoryPath, 'config', 'user.email', 'repofocus-tests@example.invalid');
  await writeFile(join(repositoryPath, 'tracked.txt'), `${name}\n`, 'utf8');
  git(repositoryPath, 'add', 'tracked.txt');
  git(repositoryPath, 'commit', '-m', 'fixture');
}

try {
  await createRepository('alpha');
  await createRepository('beta');
  for (let index = 3; index <= 15; index += 1) {
    await createRepository(`repo-${String(index).padStart(2, '0')}`);
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
  git(alphaUpdaterPath, 'config', 'user.name', 'RepoFocus Tests');
  git(alphaUpdaterPath, 'config', 'user.email', 'repofocus-tests@example.invalid');

  await runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: '1.131.0' }),
    extensionDevelopmentPath: projectRoot,
    extensionTestsPath: join(projectRoot, 'dist-tests', 'integration.js'),
    extensionTestsEnv: {
      REPOFOCUS_INTEGRATION_ROOT: fixtureRoot,
      REPOFOCUS_INTEGRATION_UPDATER: alphaUpdaterPath,
      REPOFOCUS_INTEGRATION_REPOSITORY_COUNT: '15',
      REPOFOCUS_VISUAL_PAUSE_MS: process.env.REPOFOCUS_VISUAL_PAUSE_MS ?? '0',
    },
    launchArgs: [
      fixtureRoot,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });

  // Second run: the multi-root shape. Two repositories with the SAME directory
  // name, in unrelated parent directories, opened as sibling workspace folders
  // through a .code-workspace file — the only way to put VS Code into a genuine
  // multi-root workspace, and the shape the single-folder run above cannot cover.
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
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: '1.131.0' }),
    extensionDevelopmentPath: projectRoot,
    extensionTestsPath: join(projectRoot, 'dist-tests', 'multiRoot.js'),
    extensionTestsEnv: {
      REPOFOCUS_MULTIROOT_FIRST: firstMultiRootFolder,
      REPOFOCUS_MULTIROOT_SECOND: secondMultiRootFolder,
    },
    launchArgs: [
      workspaceFile,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(remoteRoot, { recursive: true, force: true });
  await rm(multiRootRoot, { recursive: true, force: true });
}
