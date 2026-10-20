import { DEFAULT_MAX_AGE_HOURS, evaluateAlerts } from "./lib/alerts.ts";

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`::error::keepalive: ${name} is not set`);
    process.exit(1);
  }
  return value.trim();
}
const fail = (message: string): never => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const url = need("SUPABASE_URL").replace(/\/$/, "");
const anon = need("ANON_KEY");
const email = need("KEEPALIVE_EMAIL");
const password = need("KEEPALIVE_PASSWORD");
const parsedMax = Number(process.env.KEEPALIVE_MAX_AGE_HOURS ?? "");
const maxAgeHours =
  Number.isFinite(parsedMax) && parsedMax >= 0 && process.env.KEEPALIVE_MAX_AGE_HOURS
    ? parsedMax
    : DEFAULT_MAX_AGE_HOURS;
const timeout = () => AbortSignal.timeout(20_000);

// 1. authenticated database activity as the dedicated low-privilege user (spec 16.4)
const tokenRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: anon, "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
  signal: timeout(),
});
if (!tokenRes.ok) fail(`token request failed with HTTP ${tokenRes.status}`);
const accessToken = ((await tokenRes.json()) as { access_token?: string }).access_token;
if (!accessToken) fail("token response contained no access_token");
console.log(`::add-mask::${accessToken}`);
const read = await fetch(`${url}/rest/v1/app_settings?select=key&limit=1`, {
  headers: { apikey: anon, authorization: `Bearer ${accessToken}` },
  signal: timeout(),
});
if (!read.ok) fail(`authenticated REST read failed with HTTP ${read.status}`);

// 2. public freshness data and the health function
const publicHeaders = { apikey: anon, authorization: `Bearer ${anon}` };
const statusRes = await fetch(`${url}/rest/v1/rpc/scan_status`, {
  method: "POST",
  headers: { ...publicHeaders, "content-type": "application/json" },
  body: "{}",
  signal: timeout(),
});
if (!statusRes.ok) fail(`scan_status failed with HTTP ${statusRes.status}`);
const status: unknown = await statusRes.json();
const healthRes = await fetch(`${url}/functions/v1/health`, {
  headers: publicHeaders,
  signal: timeout(),
});
const health: unknown = healthRes.ok ? await healthRes.json() : null;

const problems = evaluateAlerts({ status, health, nowMs: Date.now(), maxAgeHours });
if (!healthRes.ok) problems.push(`health function answered HTTP ${healthRes.status}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(
  `keep-alive OK: authenticated read HTTP 200, freshness within ${maxAgeHours} h, health ok`,
);
