import { DEFAULT_SETTINGS } from "../supabase/functions/_shared/core/indicator.ts";
import { buildParityReport, formatParityReport } from "./lib/parity.ts";

// bun run parity -- --symbol MSFT [--as-of 2026-10-15] [--length 2500]
// Reads the stored series through the public RPC get_price_series. Environment: SUPABASE_URL and SUPABASE_ANON_KEY
// (or the VITE_ names); locally the values of `bunx supabase status`.
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const symbol = flag("symbol");
const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? "";
if (symbol === undefined || url === "" || anon === "") {
  console.error(
    "usage: bun run parity -- --symbol <Yahoo symbol> [--as-of YYYY-MM-DD] [--length N]; set SUPABASE_URL and SUPABASE_ANON_KEY",
  );
  process.exit(2);
}
const headers = {
  apikey: anon,
  authorization: `Bearer ${anon}`,
  "content-type": "application/json",
};
const sec = (await (
  await fetch(`${url}/rest/v1/securities?select=id&yahoo_symbol=eq.${encodeURIComponent(symbol)}`, {
    headers,
  })
).json()) as Array<{ id: string }>;
if (sec[0] === undefined) {
  console.error(`no security with Yahoo symbol ${symbol}`);
  process.exit(1);
}
const res = await fetch(`${url}/rest/v1/rpc/get_price_series`, {
  method: "POST",
  headers,
  body: JSON.stringify({ p_security_id: sec[0].id }),
});
const body = (await res.json()) as unknown;
const row = (Array.isArray(body) ? body[0] : body) as
  | { bar_dates: number[]; close: number[]; high: number[]; low: number[] }
  | undefined;
if (!res.ok || row === undefined || row === null) {
  console.error(`get_price_series failed: HTTP ${res.status}`);
  process.exit(1);
}
const dates = row.bar_dates.map((d) => new Date(d * 86_400_000).toISOString().slice(0, 10));
const length = flag("length");
const asOf = flag("as-of");
const report = buildParityReport(
  { dates, close: row.close, high: row.high, low: row.low },
  {
    ...(asOf === undefined ? {} : { asOf }),
    settings: { ...DEFAULT_SETTINGS, ...(length === undefined ? {} : { length: Number(length) }) },
  },
);
if (!report.ok) {
  console.error(`cannot compute the channel: ${report.reason}`);
  process.exit(1);
}
console.log(formatParityReport(symbol, report));
