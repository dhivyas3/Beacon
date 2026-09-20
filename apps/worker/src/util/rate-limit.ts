import { sleep } from './async.js';

/**
 * Paces requests to at most `rps` per second. Every caller of `take()` waits for its own slot, so
 * bursts from many parallel workers are smoothed out. `penalize()` halves the rate for 30 seconds
 * (up to 8 times slower) after the target answers 429 or 503, then it recovers by itself.
 */
export class RateLimiter {
  private nextSlot = 0;
  private factor = 1;
  private recoverAt = 0;

  constructor(
    private readonly rps: number,
    private readonly now: () => number = Date.now,
  ) {}

  async take(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    if (now >= this.recoverAt) this.factor = 1;
    const interval = (1000 / this.rps) * this.factor;
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + interval;
    await sleep(slot - now, signal);
  }

  penalize(): void {
    this.factor = Math.min(8, this.factor * 2);
    this.recoverAt = this.now() + 30_000;
  }

  /** Current slowdown, 1 when healthy. Exposed for tests and logs. */
  get slowdown(): number {
    return this.now() >= this.recoverAt ? 1 : this.factor;
  }
}

/** Keeps at least `delayMs` between requests to the same host. */
export class HostThrottle {
  private readonly nextSlot = new Map<string, number>();

  constructor(
    private readonly delayMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async wait(host: string, signal?: AbortSignal): Promise<void> {
    if (this.delayMs <= 0) return;
    const now = this.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + this.delayMs);
    await sleep(slot - now, signal);
  }
}
