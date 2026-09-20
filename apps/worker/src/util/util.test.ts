import { describe, expect, it } from 'vitest';
import { runPool, sleep } from './async.js';
import { fingerprintOf, normalizeMessage } from './fingerprint.js';
import { HostThrottle, RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  it('halves the rate after a penalty and recovers after 30 seconds', () => {
    let now = 1000;
    const limiter = new RateLimiter(10, () => now);
    expect(limiter.slowdown).toBe(1);
    limiter.penalize();
    expect(limiter.slowdown).toBe(2);
    limiter.penalize();
    limiter.penalize();
    limiter.penalize();
    limiter.penalize();
    expect(limiter.slowdown).toBe(8); // capped
    now += 30_001;
    expect(limiter.slowdown).toBe(1);
  });

  it('books later slots for parallel callers so a burst is smoothed out', async () => {
    const limiter = new RateLimiter(50); // 20 ms apart
    const started = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => limiter.take()));
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});

describe('HostThrottle', () => {
  it('delays repeat requests to one host but not to others', async () => {
    const throttle = new HostThrottle(60);
    const started = Date.now();
    await throttle.wait('a.example');
    await throttle.wait('b.example');
    expect(Date.now() - started).toBeLessThan(40);
    await throttle.wait('a.example');
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it('does nothing when the delay is zero', async () => {
    const throttle = new HostThrottle(0);
    const started = Date.now();
    for (let i = 0; i < 5; i++) await throttle.wait('a.example');
    expect(Date.now() - started).toBeLessThan(30);
  });
});

describe('sleep', () => {
  it('wakes early with false when aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    expect(await sleep(5000, controller.signal)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('runPool', () => {
  it('never exceeds the concurrency limit and processes every item', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(15);
      seen.push(item);
      active -= 1;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps going when one item throws and reports it', async () => {
    const errors: unknown[] = [];
    const done: number[] = [];
    await runPool(
      [1, 2, 3],
      2,
      async (item) => {
        if (item === 2) throw new Error('boom');
        done.push(item);
      },
      { onError: (error) => errors.push(error) },
    );
    expect(done.sort()).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
  });

  it('stops taking new items once aborted', async () => {
    const controller = new AbortController();
    const done: number[] = [];
    await runPool(
      Array.from({ length: 20 }, (_, i) => i),
      2,
      async (item) => {
        done.push(item);
        if (item === 3) controller.abort();
        await sleep(5);
      },
      { signal: controller.signal },
    );
    expect(done.length).toBeLessThan(10);
  });
});

describe('fingerprints', () => {
  it('is stable and depends on check, rule and subject', () => {
    const a = fingerprintOf('images', 'images.broken', 'https://x.com/a.jpg');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOf('images', 'images.broken', 'https://x.com/a.jpg')).toBe(a);
    expect(fingerprintOf('images', 'images.broken', 'https://x.com/b.jpg')).not.toBe(a);
    expect(fingerprintOf('images', 'images.missing-alt', 'https://x.com/a.jpg')).not.toBe(a);
    expect(fingerprintOf('seo', 'images.broken', 'https://x.com/a.jpg')).not.toBe(a);
  });

  it('treats a missing subject as an empty one', () => {
    expect(fingerprintOf('seo', 'seo.missing-title', null)).toBe(
      fingerprintOf('seo', 'seo.missing-title', null),
    );
  });

  it('normalises numbers and hashes in messages so runs compare equal', () => {
    expect(normalizeMessage('Failed after 1523 ms (id 9f8e7d6c5b4a)')).toBe(
      'Failed after # ms (id #)',
    );
    expect(normalizeMessage('  lots   of   space  ')).toBe('lots of space');
  });
});
