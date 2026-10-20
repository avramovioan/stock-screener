import { fxRowFor } from "../../_shared/adapters/fx.ts";
import { fetchAll, upsertChunks } from "../lib/data.ts";
import { FatalJobError, type Handler, type Seeder } from "../types.ts";

/** Stage 1 `fx` (key `all`): USD-per-unit rates for every currency the scan can meet. Frankfurter first, Yahoo for the gaps (5.4). */
export const handleFx: Handler = async (ctx) => {
  const sb = ctx.db.sb;
  const exchanges = await fetchAll<{ currencies: string[] }>(
    "exchanges.currencies",
    (a, b) =>
      sb
        .from("exchanges")
        .select("currencies")
        .eq("screener_enabled", true)
        .order("code")
        .range(a, b) as unknown as PromiseLike<{
        data: { currencies: string[] }[] | null;
        error: { message: string } | null;
      }>,
  );
  const securities = await fetchAll<{ currency_major: string }>(
    "securities.currencies",
    (a, b) =>
      sb
        .from("securities")
        .select("currency_major")
        .eq("status", "active")
        .order("id")
        .range(a, b) as unknown as PromiseLike<{
        data: { currency_major: string }[] | null;
        error: { message: string } | null;
      }>,
  );
  const wanted = [
    ...new Set([
      "USD",
      ...exchanges.flatMap((e) => e.currencies),
      ...securities.map((s) => s.currency_major),
    ]),
  ].sort();

  const { rates, missing } = await ctx.providers.fx.usdPerUnit(wanted);
  if (rates.length === 0) throw new Error("fx_unavailable: no provider returned a rate");
  if (!rates.some((r) => r.ccy === "USD"))
    throw new FatalJobError("fx_invalid: USD identity row missing");

  await upsertChunks(
    sb,
    "fx_rates",
    rates.map((r) => fxRowFor(r.ccy, r)),
    "rate_date,ccy",
  );
  const newest =
    rates
      .map((r) => r.rateDate)
      .sort()
      .at(-1) ?? null;
  if (missing.length > 0) await ctx.log("fx_missing", { currencies: missing }, { level: "warn" });
  const sources: Record<string, number> = {};
  for (const r of rates) sources[r.source] = (sources[r.source] ?? 0) + 1;
  return { rate_date: newest, rates: rates.length, sources, missing };
};

/** `fx` is seeded by app.start_daily_scan; this seeder only exists so a manual re-seed of a wiped stage works. */
export const seedFx: Seeder = () => Promise.resolve({ keys: ["all"], priorities: [10] });
