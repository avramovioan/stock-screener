import * as webpush from "jsr:@negrel/webpush@0.5.0";

export interface PushEnv {
  /** base64url application server key (VAPID public key), also shipped to the SPA */
  publicKey: string;
  /** JWK JSON of the EC P-256 private key (or the {publicKey, privateKey} JSON of the generator) */
  privateKeyJwk: string;
  /** mailto: or https: contact for the push service operators */
  subject: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendPushOptions {
  ttlSeconds: number;
  topic: string;
  urgency: "very-low" | "low" | "normal" | "high";
}

export type PushResult =
  | { ok: true }
  | {
      ok: false;
      kind: "gone" | "payload_too_large" | "rate_limited" | "http" | "network";
      status?: number;
      retryAfterSec?: number;
    };

export interface PushDeps {
  env?: PushEnv;
  /** test seam: the library calls the global fetch, so it is swapped for the duration of one send */
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

/** Reads the three VAPID secrets. Error messages name variables, never values. */
export function loadPushEnv(
  get: (name: string) => string | undefined = (n) => Deno.env.get(n),
): PushEnv {
  const need = (name: string): string => {
    const value = get(name);
    if (value === undefined || value.trim() === "")
      throw new Error(`Missing required environment variable: ${name}`);
    return value.trim();
  };
  const publicKey = need("VAPID_PUBLIC_KEY");
  const privateKeyJwk = need("VAPID_PRIVATE_KEY");
  const subject = need("VAPID_SUBJECT");
  if (!/^(mailto:|https:\/\/)/.test(subject))
    throw new Error("VAPID_SUBJECT must start with mailto: or https://");
  return { publicKey, privateKeyJwk, subject };
}

const servers = new Map<string, Promise<webpush.ApplicationServer>>();

async function createServer(env: PushEnv): Promise<webpush.ApplicationServer> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(env.privateKeyJwk) as Record<string, unknown>;
  } catch {
    throw new Error("VAPID_PRIVATE_KEY must be JSON (an EC P-256 private JWK)");
  }
  const priv = (parsed.privateKey ?? parsed) as JsonWebKey;
  if (priv.kty !== "EC" || priv.crv !== "P-256" || !priv.d || !priv.x || !priv.y) {
    throw new Error("VAPID_PRIVATE_KEY must be an EC P-256 private JWK");
  }
  const pub: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: priv.x,
    y: priv.y,
    ext: true,
    key_ops: ["verify"],
  };
  const vapidKeys = await webpush.importVapidKeys(
    { publicKey: pub, privateKey: priv },
    { extractable: false },
  );
  if ((await webpush.exportApplicationServerKey(vapidKeys)) !== env.publicKey) {
    throw new Error("VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY");
  }
  return await webpush.ApplicationServer.new({ contactInformation: env.subject, vapidKeys });
}

function serverFor(env: PushEnv): Promise<webpush.ApplicationServer> {
  const cacheKey = `${env.publicKey}|${env.subject}`;
  let server = servers.get(cacheKey);
  if (server === undefined) {
    server = createServer(env);
    servers.set(cacheKey, server);
    server.catch(() => servers.delete(cacheKey));
  }
  return server;
}

let chain: Promise<unknown> = Promise.resolve();
function withFetch<T>(impl: typeof fetch | undefined, run: () => Promise<T>): Promise<T> {
  if (impl === undefined) return run();
  const next = chain.then(async () => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  });
  chain = next.catch(() => undefined);
  return next;
}

const URGENCY: Record<SendPushOptions["urgency"], webpush.Urgency> = {
  "very-low": webpush.Urgency.VeryLow,
  low: webpush.Urgency.Low,
  normal: webpush.Urgency.Normal,
  high: webpush.Urgency.High,
};

function retryAfterSeconds(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - nowMs) / 1000);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.min(Math.max(seconds, 0), 86_400);
}

export async function sendPush(
  sub: PushTarget,
  payloadJson: string,
  opts: SendPushOptions,
  deps: PushDeps = {},
): Promise<PushResult> {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) {
    throw new RangeError("Topic must be 1 to 32 characters of the URL-safe base64 alphabet");
  }
  if (!Number.isInteger(opts.ttlSeconds) || opts.ttlSeconds <= 0)
    throw new RangeError("ttlSeconds must be a positive integer");
  const env = deps.env ?? loadPushEnv();
  const server = await serverFor(env);
  const subscriber = server.subscribe({
    endpoint: sub.endpoint,
    keys: { auth: sub.auth, p256dh: sub.p256dh },
  });
  try {
    await withFetch(deps.fetchImpl, () =>
      subscriber.pushTextMessage(payloadJson, {
        ttl: opts.ttlSeconds,
        topic: opts.topic,
        urgency: URGENCY[opts.urgency],
      }),
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof webpush.PushMessageError) {
      const status = error.response.status;
      const retry = retryAfterSeconds(
        error.response.headers.get("retry-after"),
        (deps.nowMs ?? Date.now)(),
      );
      try {
        await error.response.body?.cancel();
      } catch {
        // the body is not needed
      }
      if (status === 404 || status === 410) return { ok: false, kind: "gone", status };
      if (status === 413) return { ok: false, kind: "payload_too_large", status };
      if (status === 429) {
        return retry === undefined
          ? { ok: false, kind: "rate_limited", status }
          : { ok: false, kind: "rate_limited", status, retryAfterSec: retry };
      }
      return { ok: false, kind: "http", status };
    }
    return { ok: false, kind: "network" };
  }
}

const EXACT_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);
const HOST_SUFFIXES = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

/** Endpoint allow-list used by push-subscribe (spec 10.4): https, default port, known push services. */
export function isAllowedPushEndpoint(
  endpoint: string,
  extraHosts: readonly string[] = [],
): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "")
    return false;
  const host = url.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost") return false;
  return (
    EXACT_HOSTS.has(host) ||
    HOST_SUFFIXES.some((s) => host.endsWith(s)) ||
    extraHosts.includes(host)
  );
}
