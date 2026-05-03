/**
 * Token bucket with smooth refill. Single-process; one instance per HubSpot
 * app guards every request from the worker + webhook handler.
 *
 * HubSpot's per-app limit on free/dev tiers is ~100 requests / 10 seconds.
 * `capacity` and `refillIntervalMs` model exactly that: tokens regenerate
 * at `capacity / refillIntervalMs` per ms, capped at `capacity`.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly capacity: number,
    private readonly refillIntervalMs: number,
  ) {
    if (capacity <= 0 || refillIntervalMs <= 0) {
      throw new Error("TokenBucket: capacity and refillIntervalMs must be > 0");
    }
    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    const gained = (elapsed / this.refillIntervalMs) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefillAt = now;
  }

  private drain(): void {
    this.refill();
    while (this.tokens >= 1 && this.queue.length > 0) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length === 0 || this.timer) return;
    const tokensShort = 1 - this.tokens;
    const waitMs = Math.max(
      1,
      Math.ceil(tokensShort * (this.refillIntervalMs / this.capacity)),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, waitMs);
  }

  async take(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }
}
