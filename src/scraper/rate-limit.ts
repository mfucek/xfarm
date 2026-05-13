export class TokenBucket {
  private tokens: number;
  private lastRefill = performance.now();
  private waiters: Array<() => void> = [];

  constructor(private ratePerMinute: number) {
    this.tokens = ratePerMinute;
  }

  private refill(): void {
    const now = performance.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.ratePerMinute,
      this.tokens + (elapsedSec * this.ratePerMinute) / 60,
    );
    this.lastRefill = now;
  }

  async acquire(cost = 1): Promise<void> {
    this.refill();
    while (this.tokens < cost) {
      const deficit = cost - this.tokens;
      const waitSec = deficit / (this.ratePerMinute / 60);
      await sleep(Math.ceil(waitSec * 1000));
      this.refill();
    }
    this.tokens -= cost;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export const jitteredSleep = (baseMs: number, pct: number): Promise<void> => {
  const frac = pct / 100;
  const delta = baseMs * frac;
  const ms = Math.max(500, baseMs + (Math.random() * 2 - 1) * delta);
  return sleep(ms);
};
