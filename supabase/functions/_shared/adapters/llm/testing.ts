import type { FetchLike } from "./types.ts";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch fake that records every call and answers with `respond`. No network is ever touched. */
export function fakeFetch(respond: (call: RecordedCall) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      headers,
      body: raw === undefined ? undefined : JSON.parse(raw),
    };
    calls.push(call);
    return await respond(call);
  };
  return { fetchImpl, calls };
}
