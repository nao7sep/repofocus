import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/extension.ts', 'src/gitApi.ts', 'src/alwaysShowWorker.ts', 'src/alwaysShowWorkerProtocol.ts'],
    },
    include: ['tests/**/*.test.ts'],
    // A test waits for the event it needs; a slow test that passes has passed.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
