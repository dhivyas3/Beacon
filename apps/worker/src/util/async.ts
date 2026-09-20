/** Resolves after `ms`, or early with `false` when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight. Stops taking new items once the
 * signal aborts. Errors thrown by `worker` are passed to `onError` and do not stop the pool.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  options: { signal?: AbortSignal; onError?: (error: unknown, item: T) => void } = {},
): Promise<void> {
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (!options.signal?.aborted) {
        const index = next++;
        if (index >= items.length) return;
        const item = items[index] as T;
        try {
          await worker(item, index);
        } catch (error) {
          options.onError?.(error, item);
        }
      }
    }),
  );
}
