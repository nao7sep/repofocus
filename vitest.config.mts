import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/extension.ts', 'src/gitApi.ts'],
    },
    include: ['tests/**/*.test.ts'],
  },
});
