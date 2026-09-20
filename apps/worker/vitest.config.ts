import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../../packages/testkit/src/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Browser tests are CPU heavy and timing sensitive, so files run one after another.
    fileParallelism: false,
  },
});
