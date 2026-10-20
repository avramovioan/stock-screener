import {
  type Category,
  classifyOperational,
  type ResearchFacts,
} from "../../_shared/core/classify.ts";
import { DbQueryError, fetchByIds, selectAll } from "../lib/data.ts";
import type { Handler, HandlerContext, Seeder } from "../types.ts";

/** Stage 7 `classify` (initial): operational category, withheld flag and display order of today's cards (4.8, 6.6.4). */
export const seedClassify: Seeder = () =>
  Promise.resolve({ keys: ["classify:initial"], priorities: [100] });

/** P1 has no research: every card is "pending". P2 replaces this function with the stored report of the security. */
export function researchFactsFor(
  _ctx: HandlerContext,
  _securityId: string,
): Promise<ResearchFacts | null> {
  return Promise.resolve(null);
}

const CLEARED: ReadonlySet<Category> = new Set(["green", "amber"]);
const ORDER: Record<Category, number> = { green: 0, amber: 1, red: 2, grey: 3, pending: 4 };

export const handleClassify: Handler = async (ctx: HandlerContext) => {
  const sb = ctx.db.sb;
  const rows = await selectAll<{ id: number; mode: string; rank: number; security_id: string }>(
    sb,
    "todays_discounts",
    "id, mode, rank, security_id",
    (q) => q.eq("scan_run_id", ctx.run.id),
  );
  const symbols = new Map(
    (
      await fetchByIds<{ id: string; yahoo_symbol: string }>(
        sb,
        "securities",
        "id, yahoo_symbol",
        "id",
        rows.map((r) => r.security_id),
      )
    ).map((s) => [s.id, s.yahoo_symbol]),
  );

  const classified = [];
  for (const row of rows) {
    const c = classifyOperational(await researchFactsFor(ctx, row.security_id));
    classified.push({ ...row, symbol: symbols.get(row.security_id) ?? "", ...c });
  }
  // cleared candidates (green, then amber) first, then the withheld ones; within a category ascending rank, then symbol (4.11)
  const counts: Record<string, number> = {};
  for (const mode of ["worldwide", "us"]) {
    const ordered = classified
      .filter((r) => r.mode === mode)
      .sort(
        (a, b) =>
          ORDER[a.category] - ORDER[b.category] ||
          a.rank - b.rank ||
          (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
      );
    for (const [i, r] of ordered.entries()) {
      const { error } = await sb
        .from("todays_discounts")
        .update({
          operational_category: r.category,
          category_reason: r.reasonCode,
          withheld: !CLEARED.has(r.category),
          display_order: i + 1,
        })
        .eq("id", r.id);
      if (error) throw new DbQueryError("todays_discounts.update", error.message);
      counts[r.category] = (counts[r.category] ?? 0) + 1;
    }
  }
  return { cards: rows.length, ...counts };
};
