import type { FetchLike } from "./throttle.ts";
import type { Recorder } from "./yahoo.ts";

/** Helpers for offline tests and for recording new fixtures in development. Nothing here touches the network. */

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export interface FixtureRoute {
  match(url: URL, init?: RequestInit): boolean;
  respond(url: URL, init?: RequestInit): Response | Promise<Response>;
}

/** A fetch that answers from a route table and throws on anything unmatched, so a test can never reach the network. */
export function routeFetch(
  routes: FixtureRoute[],
): FetchLike & { calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = [];
  const impl: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ method: init?.method ?? "GET", url: url.toString() });
    const route = routes.find((r) => r.match(url, init));
    if (route === undefined)
      throw new Error(
        `fixtureFetch: no route for ${init?.method ?? "GET"} ${url.origin}${url.pathname}`,
      );
    return await route.respond(url, init);
  };
  return Object.assign(impl, { calls });
}

/** Reads fixtures/<relative> next to this module (recorded Yahoo samples live in fixtures/yahoo). */
export async function readFixture<T = unknown>(relative: string): Promise<T> {
  const text = await Deno.readTextFile(new URL(`./fixtures/${relative}`, import.meta.url));
  return JSON.parse(text) as T;
}

/**
 * Development recorder: writes one file per response to fixtures/yahoo/recorded/. The crumb is already stripped from the URL by the
 * provider and cookies are never part of an entry. Requires --allow-write on that directory; never enabled in production.
 */
export function diskRecorder(
  dir = new URL("./fixtures/yahoo/recorded/", import.meta.url),
): Recorder {
  return async (entry) => {
    const u = new URL(entry.url);
    const slug = `${entry.method}_${u.host}${u.pathname}`.replace(/[^A-Za-z0-9._-]+/g, "_");
    const hash = Array.from(new TextEncoder().encode(entry.url + entry.body.length))
      .reduce((h, b) => (h * 31 + b) >>> 0, 7)
      .toString(16);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(new URL(`${slug}_${hash}.json`, dir), entry.body);
  };
}
