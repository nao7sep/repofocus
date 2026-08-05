import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtureRoot = await mkdtemp(join(tmpdir(), 'repofocus-integration-'));
const vscodeExecutablePath = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

function git(repositoryPath, ...args) {
  execFileSync('git', args, { cwd: repositoryPath, stdio: 'ignore' });
}

async function createRepository(name) {
  const repositoryPath = join(fixtureRoot, name);
  await mkdir(repositoryPath);
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

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: projectRoot,
    extensionTestsPath: join(projectRoot, 'dist-tests', 'integration.js'),
    extensionTestsEnv: {
      REPOFOCUS_INTEGRATION_ROOT: fixtureRoot,
      REPOFOCUS_VISUAL_PAUSE_MS: process.env.REPOFOCUS_VISUAL_PAUSE_MS ?? '0',
    },
    launchArgs: [
      fixtureRoot,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
