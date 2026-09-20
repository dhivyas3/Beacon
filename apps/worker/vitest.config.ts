import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../../packages/testkit/src/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
