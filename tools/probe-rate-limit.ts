// Usage: bun run probe:ratelimit -- --url http://127.0.0.1:54321/functions/v1/quotes/MSFT --limit 60 [--method GET]
// Needs SUPABASE_ANON_KEY in the environment (sent as apikey and bearer). Exits 1 when a spoofed X-Forwarded-For bypasses the limit
// or when a single client is limited before `limit` requests.
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = flag("url");
const limit = Number(flag("limit") ?? "60");
const method = flag("method") ?? "GET";
const anon = process.env.SUPABASE_ANON_KEY ?? "";
if (url === undefined || !Number.isFinite(limit) || anon === "") {
  console.error(
    "usage: bun run probe:ratelimit -- --url <function url> --limit <n> [--method GET|POST]; set SUPABASE_ANON_KEY",
  );
  process.exit(2);
}
const base = { apikey: anon, authorization: `Bearer ${anon}` };
const hit = async (extra: Record<string, string>) =>
  (
    await fetch(url, {
      method,
      headers: { ...base, ...extra },
      ...(method === "POST" ? { body: "{}" } : {}),
    })
  ).status;

// 1. rotate the left-most X-Forwarded-For entry: a spoofing client must still run into the limit
let limited = 0;
for (let i = 0; i < limit + 15; i++)
  if ((await hit({ "x-forwarded-for": `10.${i % 250}.${i % 200}.${i % 100}` })) === 429)
    limited += 1;
console.log(`spoofed X-Forwarded-For: ${limited} of ${limit + 15} requests were limited`);

// 2. next minute: one honest client gets its full allowance
const wait = 61_000 - (Date.now() % 60_000);
console.log(`waiting ${Math.round(wait / 1000)} s for a fresh minute bucket`);
await new Promise((resolve) => setTimeout(resolve, wait));
let early = 0;
for (let i = 0; i < limit; i++) if ((await hit({})) === 429) early += 1;
console.log(`single client: ${early} of ${limit} requests were limited`);

const failures: string[] = [];
if (limited === 0) failures.push("a rotating X-Forwarded-For bypassed the limit");
if (early > 0) failures.push("a single client was limited before its allowance");
if (failures.length > 0) {
  console.error(`probe:ratelimit FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("probe:ratelimit OK");

export {};
