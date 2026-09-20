import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../testkit/src/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    fileParallelism: true,
  },
});
