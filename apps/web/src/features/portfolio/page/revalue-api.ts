export type RevalueResult =
  | { kind: "ok" }
  | { kind: "cooldown"; nextAllowedAt: string | null }
  | { kind: "error"; message: string };

export interface RevalueApiOptions {
  url: string;
  anonKey: string;
  getAccessToken(): Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export interface RevalueApi {
  /** Re-evaluate one holding against today's channel (once a day per holding, enforced by the server). */
  revalue(conid: number): Promise<RevalueResult>;
}

const FAILED: RevalueResult = { kind: "error", message: "The re-evaluation failed. Try again." };

/** `POST portfolio-refresh { action: "revalue", conid }` with the user's JWT. */
export function createRevalueApi(o: RevalueApiOptions): RevalueApi {
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    async revalue(conid) {
      const token = await o.getAccessToken();
      if (token === null) return { kind: "error", message: "Sign in again to re-evaluate." };
      let res: Response;
      try {
        res = await doFetch(o.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: o.anonKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "revalue", conid }),
        });
      } catch {
        return { kind: "error", message: "Network error: could not reach the server." };
      }
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        next_allowed_at?: string | null;
      } | null;
      if (res.status === 429)
        return { kind: "cooldown", nextAllowedAt: body?.next_allowed_at ?? null };
      return res.ok && body?.ok === true ? { kind: "ok" } : FAILED;
    },
  };
}
