// biome-ignore-all lint/suspicious/noExplicitAny: recorded provider samples and PostgREST/function responses are untyped JSON
// Shared helpers for tools/run-local-scan.ts and tools/test-integration.ts: talk to the LOCAL stack with plain fetch.

import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";

export interface Stack {
  url: string;
  serviceKey: string;
  anonKey: string;
  jwtSecret: string;
  cronSecret: string;
}

export function assertLocalUrl(url: string): void {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost")
    throw new Error(`refusing fixture mode against a non-local URL: ${url}`);
}

/** URL and service key from the environment, else from `bunx supabase status -o json` (legacy JWT service key). */
export function resolveStack(): Stack {
  let url = process.env.SUPABASE_URL;
  let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let anonKey = process.env.SUPABASE_ANON_KEY;
  let jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (
    url === undefined ||
    serviceKey === undefined ||
    anonKey === undefined ||
    jwtSecret === undefined
  ) {
    const out = spawnSync("bunx", ["supabase", "status", "-o", "json"], {
      encoding: "utf8",
      shell: true,
    });
    if (out.status !== 0) throw new Error(`supabase status failed: ${out.stderr}`);
    const status = JSON.parse(out.stdout) as {
      API_URL: string;
      SERVICE_ROLE_KEY: string;
      ANON_KEY: string;
      JWT_SECRET: string;
    };
    url ??= status.API_URL;
    serviceKey ??= status.SERVICE_ROLE_KEY;
    anonKey ??= status.ANON_KEY;
    jwtSecret ??= status.JWT_SECRET;
  }
  return {
    url,
    serviceKey,
    anonKey,
    jwtSecret,
    cronSecret: process.env.CRON_SHARED_SECRET ?? "local-dev-cron-secret",
  };
}

export async function callFunction(
  stack: Stack,
  name: string,
  body: unknown,
  timeoutMs = 170_000,
): Promise<any> {
  const res = await fetch(`${stack.url}/functions/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": stack.cronSecret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok && res.status !== 202)
    throw new Error(`${name} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

/** PostgREST read with the service key. `path` is e.g. "scan_runs?select=id&order=started_at.desc". */
export async function rest(stack: Stack, path: string): Promise<any[]> {
  const res = await fetch(`${stack.url}/rest/v1/${path}`, {
    headers: { apikey: stack.serviceKey, authorization: `Bearer ${stack.serviceKey}` },
  });
  if (!res.ok) throw new Error(`rest ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as any[];
}

/** PostgREST write with the service key. LOCAL stack only: it refuses any other URL. */
export async function restWrite(
  stack: Stack,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  prefer = "return=minimal",
): Promise<any> {
  assertLocalUrl(stack.url);
  const res = await fetch(`${stack.url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: stack.serviceKey,
      authorization: `Bearer ${stack.serviceKey}`,
      "content-type": "application/json",
      prefer,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`rest ${method} ${path} -> HTTP ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text === "" ? null : JSON.parse(text);
}

/** PostgREST read with the anon key (the public views a signed-out visitor sees). */
export async function restAnon(stack: Stack, path: string): Promise<any[]> {
  const res = await fetch(`${stack.url}/rest/v1/${path}`, {
    headers: { apikey: stack.anonKey, authorization: `Bearer ${stack.anonKey}` },
  });
  if (!res.ok) throw new Error(`anon rest ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as any[];
}

/**
 * A user access token (HS256, signed with the LOCAL JWT secret) carrying the issuer the local Auth service issues to a real sign-in
 * (`${stack.url}/auth/v1`, `http://127.0.0.1:54321/auth/v1`). The local functions must run with `JWT_ISSUER` set to that same value
 * (supabase/functions/.env), the one configuration the e2e browser sign-ins and this tool share; they see `SUPABASE_URL=http://kong:8000`,
 * so without `JWT_ISSUER` every local user token is refused.
 */
export function mintUserJwt(stack: Stack, userId: string, email: string): string {
  assertLocalUrl(stack.url);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({
    iss: `${stack.url.replace(/[/]+$/, "")}/auth/v1`,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    iat: now,
    exp: now + 900,
    email,
    app_metadata: {},
    user_metadata: {},
  });
  const sig = createHmac("sha256", stack.jwtSecret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** Creates a confirmed auth user through the admin API (local stack only). */
export async function createUser(
  stack: Stack,
  email: string,
  password: string,
): Promise<{ id: string }> {
  assertLocalUrl(stack.url);
  const res = await fetch(`${stack.url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: stack.serviceKey,
      authorization: `Bearer ${stack.serviceKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`createUser -> HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

/** Deletes an auth user (cascades the profile and everything that references it). */
export async function deleteUser(stack: Stack, id: string): Promise<void> {
  assertLocalUrl(stack.url);
  await fetch(`${stack.url}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: { apikey: stack.serviceKey, authorization: `Bearer ${stack.serviceKey}` },
  });
}

export async function rpc(
  stack: Stack,
  name: string,
  args: unknown,
  schema = "public",
): Promise<any> {
  const res = await fetch(`${stack.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: stack.serviceKey,
      authorization: `Bearer ${stack.serviceKey}`,
      "content-type": "application/json",
      "content-profile": schema,
      "accept-profile": schema,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${name} -> HTTP ${res.status}: ${await res.text()}`);
  return await res.json();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Terminal = complete or failed, or partial with finished_at set (all jobs terminal). */
export function isTerminal(run: { status: string; finished_at: string | null }): boolean {
  return (
    run.status === "complete" ||
    run.status === "failed" ||
    (run.status === "partial" && run.finished_at !== null)
  );
}
