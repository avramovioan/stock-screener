/** Injected time source so throttling, breakers and expiries are testable without real timers. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** Virtual clock: sleep advances time instantly. `sleeps` records every requested delay. */
export function createFakeClock(
  startMs = Date.UTC(2026, 9, 15, 7, 0, 0),
): Clock & { advance(ms: number): void; sleeps: number[] } {
  let t = startMs;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms) => {
      const d = Math.max(0, ms);
      sleeps.push(d);
      t += d;
      return Promise.resolve();
    },
    advance: (ms) => {
      t += ms;
    },
    sleeps,
  };
}
