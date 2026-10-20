import type { FetchLike } from "../llm/types.ts";
import { publicUrlProblem, readCapped } from "./direct.ts";
import { jinaKeylessLimiter, type Limiter } from "./limiter.ts";

export function readerUrl(url: string): string {
  return `https://r.jina.ai/${url}`;
}

export interface JinaOptions {
  apiKey?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Upper bound on the returned text; callers apply `capText` afterwards. */
  maxChars?: number | undefined;
  limiter?: Limiter | undefined;
}

export type JinaResult =
  | { ok: true; status: number; text: string }
  | {
      ok: false;
      kind: "rate_limited" | "http" | "timeout" | "network" | "blocked";
      status?: number | undefined;
      message: string;
    };

/** Public URL in, markdown or text out. Header options beyond the optional bearer are UNVERIFIED and not used. */
export async function readViaJina(url: string, opts: JinaOptions = {}): Promise<JinaResult> {
  const problem = publicUrlProblem(url);
  if (problem) return { ok: false, kind: "blocked", message: problem };
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const apiKey = opts.apiKey?.trim() ?? "";
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 25_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const scrub = (message: string): string =>
    apiKey === "" ? message : message.split(apiKey).join("[redacted]");
  const headers: Record<string, string> = { accept: "text/plain" };
  if (apiKey !== "") headers.authorization = `Bearer ${apiKey}`;
  await (
    opts.limiter ?? (apiKey === "" ? jinaKeylessLimiter : { take: () => Promise.resolve() })
  ).take();
  let res: Response;
  try {
    res = await doFetch(readerUrl(url), { method: "GET", headers, signal });
  } catch (e) {
    const timedOut =
      signal.aborted &&
      signal.reason instanceof DOMException &&
      signal.reason.name === "TimeoutError";
    return timedOut
      ? { ok: false, kind: "timeout", message: "Jina Reader timed out" }
      : {
          ok: false,
          kind: "network",
          message: scrub(e instanceof Error ? e.message : String(e)).slice(0, 200),
        };
  }
  if (res.status === 429) {
    await res.body?.cancel();
    return { ok: false, kind: "rate_limited", status: 429, message: "Jina Reader rate limit" };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return {
      ok: false,
      kind: "http",
      status: res.status,
      message: `Jina Reader HTTP ${res.status}`,
    };
  }
  const maxChars = opts.maxChars ?? 200_000;
  try {
    const { bytes } = await readCapped(res, maxChars * 4); // at most 4 bytes per character
    return {
      ok: true,
      status: res.status,
      text: new TextDecoder().decode(bytes).slice(0, maxChars),
    };
  } catch (e) {
    return {
      ok: false,
      kind: "network",
      message: scrub(e instanceof Error ? e.message : String(e)).slice(0, 200),
    };
  }
}
