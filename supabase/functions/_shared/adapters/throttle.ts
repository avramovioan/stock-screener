import type { Clock } from "./clock.ts";
import type { KvStore } from "./store.ts";

/** Spec 5.3: the single egress point to Yahoo. Pacing, retry with backoff, circuit breaker, budget, metrics. No globals. */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BreakerState {
  consecutiveFailures: number;
  openUntilMs: number | null;
}
export interface BreakerStore {
  load(): Promise<BreakerState>;
  save(state: BreakerState): Promise<void>;
}

export interface RateConfig {
  /** Minimum gap between two request starts. 340 ms keeps one invocation below 3 requests per second. */
  minSpacingMs: number;
  /** Extra random gap in [0, jitterMs). */
  jitterMs: number;
}
export const DEFAULT_RATE: Readonly<RateConfig> = Object.freeze({
  minSpacingMs: 340,
  jitterMs: 100,
});

export class YahooUnavailableError extends Error {
  constructor(readonly untilMs: number) {
    super(`yahoo_unavailable until ${new Date(untilMs).toISOString()}`);
    this.name = "YahooUnavailableError";
  }
}
export class BudgetExceededError extends Error {
  constructor() {
    super("yahoo_budget_exceeded");
    this.name = "BudgetExceededError";
  }
}

export interface ThrottleOptions {
  fetchImpl: FetchLike;
  clock: Clock;
  breaker: BreakerStore;
  rate?: RateConfig;
  rng?: () => number;
  timeoutMs?: number; // 20 s per request
  maxAttempts?: number; // 4
  breakerThreshold?: number; // 5 consecutive 429 or 5xx
  breakerOpenMs?: number; // 10 minutes
  budgetMs?: number; // 90 s of wall time per invocation: no new request after that
  onEvent?: (event: string, data: Record<string, unknown>) => void;
  /** Kill switch (spec 15.5): when it resolves false no request is made and YahooUnavailableError is thrown. */
  isEnabled?: () => Promise<boolean>;
}

export interface ThrottleStats {
  requests: number; // attempts started
  retries: number;
  status429: number;
  status5xx: number;
  networkErrors: number;
  totalMs: number;
  byPath: Record<string, { n: number; ms: number }>; // host + path only: never a query string (crumb)
}

export interface Throttle {
  fetch: FetchLike;
  stats(): ThrottleStats;
}

export function createKvBreakerStore(kv: KvStore, key = "yahoo:breaker"): BreakerStore {
  return {
    async load() {
      const v = await kv.get<BreakerState>(key);
      return v ?? { consecutiveFailures: 0, openUntilMs: null };
    },
    save(state) {
      return kv.set(key, state, 60 * 60_000);
    },
  };
}

function urlOf(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

/** Retry-After as milliseconds (seconds or an HTTP date), capped at 60 s. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(60_000, secs * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(60_000, Math.max(0, at - nowMs));
  return null;
}

export function createThrottle(opts: ThrottleOptions): Throttle {
  const rate = opts.rate ?? DEFAULT_RATE;
  const rng = opts.rng ?? Math.random;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxAttempts = opts.maxAttempts ?? 4;
  const threshold = opts.breakerThreshold ?? 5;
  const openMs = opts.breakerOpenMs ?? 10 * 60_000;
  const budgetMs = opts.budgetMs ?? 90_000;
  const emit = opts.onEvent ?? (() => undefined);
  const { clock } = opts;

  const started = clock.now();
  let lastStart = Number.NEGATIVE_INFINITY;
  let state: BreakerState | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const stats: ThrottleStats = {
    requests: 0,
    retries: 0,
    status429: 0,
    status5xx: 0,
    networkErrors: 0,
    totalMs: 0,
    byPath: {},
  };

  async function breakerState(): Promise<BreakerState> {
    if (state === null) state = await opts.breaker.load();
    return state;
  }

  function record(url: URL, ms: number): void {
    const key = `${url.host}${url.pathname}`;
    const entry = stats.byPath[key] ?? { n: 0, ms: 0 };
    entry.n += 1;
    entry.ms += ms;
    stats.byPath[key] = entry;
    stats.totalMs += ms;
  }

  async function once(
    input: string | URL | Request,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const st = await breakerState();
    const url = urlOf(input);
    let lastResponse: Response | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (clock.now() - started >= budgetMs) throw new BudgetExceededError();
      if (opts.isEnabled !== undefined && !(await opts.isEnabled()))
        throw new YahooUnavailableError(clock.now() + 15 * 60_000);
      if (st.openUntilMs !== null && clock.now() < st.openUntilMs)
        throw new YahooUnavailableError(st.openUntilMs);

      const gap = rate.minSpacingMs + rng() * rate.jitterMs;
      const wait = lastStart + gap - clock.now();
      if (wait > 0) await clock.sleep(wait);
      lastStart = clock.now();
      stats.requests += 1;
      if (attempt > 1) stats.retries += 1;

      let response: Response | null = null;
      let failure: "429" | "5xx" | "network" | null = null;
      const t0 = clock.now();
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        response = await opts.fetchImpl(input, { ...init, signal });
        if (response.status === 429) failure = "429";
        else if (response.status >= 500) failure = "5xx";
      } catch (e) {
        failure = "network";
        lastError = e;
        stats.networkErrors += 1;
      }
      record(url, clock.now() - t0);

      if (failure === null && response !== null) {
        if (st.consecutiveFailures > 0 || st.openUntilMs !== null) {
          const wasOpen = st.openUntilMs !== null;
          st.consecutiveFailures = 0;
          st.openUntilMs = null;
          await opts.breaker.save(st);
          if (wasOpen) emit("yahoo_breaker_closed", {});
        }
        return response;
      }

      if (failure === "429") stats.status429 += 1;
      if (failure === "5xx") stats.status5xx += 1;
      emit(failure === "429" ? "yahoo_429" : "yahoo_failure", {
        kind: failure,
        attempt,
        path: url.pathname,
      });
      st.consecutiveFailures += 1;
      if (st.consecutiveFailures >= threshold) {
        st.openUntilMs = clock.now() + openMs;
        await opts.breaker.save(st);
        if (response !== null) await response.body?.cancel();
        emit("yahoo_breaker_open", { until: new Date(st.openUntilMs).toISOString() });
        throw new YahooUnavailableError(st.openUntilMs);
      }
      await opts.breaker.save(st);

      if (attempt < maxAttempts) {
        const base = Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.5 + rng());
        const retryAfter =
          response === null
            ? null
            : parseRetryAfter(response.headers.get("retry-after"), clock.now());
        if (response !== null) await response.body?.cancel();
        lastResponse = null;
        await clock.sleep(retryAfter ?? base);
      } else {
        lastResponse = response;
      }
    }
    if (lastResponse !== null) return lastResponse; // exhausted on an HTTP error: the caller sees the status
    throw lastError instanceof Error ? lastError : new Error("yahoo_request_failed");
  }

  const throttled: FetchLike = (input, init) => {
    const run = () => once(input, init);
    const p = chain.then(run, run); // concurrency 1: requests are strictly serialised
    chain = p.catch(() => undefined);
    return p;
  };

  return { fetch: throttled, stats: () => ({ ...stats, byPath: { ...stats.byPath } }) };
}
