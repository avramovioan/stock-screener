export interface Limiter {
  take(): Promise<void>;
}

/** Token bucket: `ratePerSec` tokens per second, at most `burst` stored. Time and sleep are injectable. */
export class TokenBucket implements Limiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst = 1,
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
      this.last = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
    }
  }
}

/** All sec.gov traffic of one isolate: 4 req/s (spec 9.4: at most 5 req/s project-wide with 2 workers). */
export const secLimiter: Limiter = new TokenBucket(4, 1);

/** Keyless Jina Reader allows 20 requests per minute. */
export const jinaKeylessLimiter: Limiter = new TokenBucket(1 / 3, 1);

export const noLimiter: Limiter = { take: () => Promise.resolve() };
