import { startStack } from './stack.js';

/** Playwright runs this once before the tests. Returning a function makes it the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack();
  return () => stack.stop();
}
