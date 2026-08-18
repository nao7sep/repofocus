import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
  },
  {
    entryPoints: ['tests/integration/index.ts'],
    outfile: 'dist-tests/integration.js',
  },
  // A second Extension Host entry point, because the multi-root case is a
  // different WORKSPACE SHAPE rather than a different assertion: it needs VS Code
  // launched on a .code-workspace listing folders from unrelated directories, so
  // it cannot ride inside the single-folder run above.
  {
    entryPoints: ['tests/integration/multiRoot.ts'],
    outfile: 'dist-tests/multiRoot.js',
  },
];

const shared = {
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
};

if (watch) {
  const contexts = await Promise.all(builds.map(options => context({ ...shared, ...options })));
  await Promise.all(contexts.map(buildContext => buildContext.watch()));
  console.log('Watching RepoFocus sources and integration tests.');
} else {
  await Promise.all(builds.map(options => build({ ...shared, ...options })));
}
