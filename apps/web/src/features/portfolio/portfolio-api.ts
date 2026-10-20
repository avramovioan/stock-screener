import type { PortfolioResponse } from "@core/portfolio-view.ts";

export type ClientPortfolio = PortfolioResponse & { receivedAtMs: number };

export class CooldownError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Manual refresh is available again in ${retryAfterSeconds} seconds.`);
    this.name = "CooldownError";
  }
}

export class NotLinkedError extends Error {
  constructor() {
    super("No broker is linked.");
    this.name = "NotLinkedError";
  }
}

export class RefreshFailure extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "RefreshFailure";
  }
}

export interface PortfolioApiOptions {
  url: string;
  anonKey: string;
  getAccessToken(): Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface PortfolioApi {
  get(): Promise<ClientPortfolio>;
  refresh(): Promise<ClientPortfolio>;
}

export function createPortfolioApi(o: PortfolioApiOptions): PortfolioApi {
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = o.now ?? (() => Date.now());

  async function call(method: "GET" | "POST"): Promise<ClientPortfolio> {
    const token = await o.getAccessToken();
    if (token === null) throw new RefreshFailure(401, "Sign in again to refresh.");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, apikey: o.anonKey };
    if (method === "POST") headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(o.url, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify({ manual: true }) } : {}),
      });
    } catch {
      throw new RefreshFailure(null, "Network error: could not reach the server.");
    }
    if (res.status === 429) {
      const fromHeader = Number(res.headers.get("retry-after"));
      const fromBody = await res
        .json()
        .then((b: { retryAfterSeconds?: number }) => Number(b.retryAfterSeconds))
        .catch(() => Number.NaN);
      throw new CooldownError(
        [fromHeader, fromBody].find((n) => Number.isFinite(n) && n > 0) ?? 60,
      );
    }
    if (res.status === 409) throw new NotLinkedError();
    if (!res.ok) throw new RefreshFailure(res.status, `The refresh failed (HTTP ${res.status}).`);
    return { ...((await res.json()) as PortfolioResponse), receivedAtMs: now() };
  }

  return { get: () => call("GET"), refresh: () => call("POST") };
}
