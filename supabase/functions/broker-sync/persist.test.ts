import { type FlexStatement, parseFlexStatement } from "@adapters/flex-parse.ts";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { latestSnapshot, maskAccountId, sha256Hex, toIngestPayload } from "./persist.ts";

const XML = await Deno.readTextFile(
  new URL("../_shared/adapters/fixtures/flex/activity-sample.xml", import.meta.url),
);
const parsed = parseFlexStatement(XML);
if (!parsed.ok) throw new Error("fixture must parse");
const statement: FlexStatement = parsed.statement;
const USER = "a0000000-0000-4000-8000-00000000000a";

Deno.test("account ids are masked to the first character and the last four", () => {
  assertEquals(maskAccountId("U1234567"), "U***4567");
  assertEquals(maskAccountId("U12"), "***");
});

Deno.test("sha256Hex is stable and hex", async () => {
  assertEquals(
    await sha256Hex("a"),
    "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
  );
});

Deno.test("meta, positions of the latest report date and snake_case columns", async () => {
  const p = await toIngestPayload(USER, statement);
  assertEquals(p.meta, {
    report_date: "2026-10-14",
    statement_from: "2026-09-15",
    statement_to: "2026-10-14",
    account_id_masked: "U***4567",
    base_currency: "EUR",
    account_type: "Individual",
  });
  assertEquals(p.positions.length, 2);
  assertEquals(p.positions[0]?.symbol, "AAPL");
  assertEquals(p.positions[0]?.cost_basis_money, 2001.7);
  assertEquals(p.positions[0]?.listing_exchange, "NASDAQ");
  assertEquals(p.positions[1]?.currency, "GBP");
  assertEquals(p.positions[1]?.mark_price, 27.35);
});

Deno.test("only the newest snapshot of a multi-day statement is used", () => {
  const older = {
    ...statement,
    positions: statement.positions.map((p, i) =>
      i === 0 ? { ...p, reportDate: "2026-10-13" } : p,
    ),
  };
  const snap = latestSnapshot(older);
  assertEquals(snap.reportDate, "2026-10-14");
  assertEquals(
    snap.positions.map((p) => p.symbol),
    ["SHEL"],
  );
  assertEquals(latestSnapshot({ ...statement, positions: [] }).reportDate, "2026-10-14");
});

Deno.test("trades keep the broker sign, partial fills stay separate, executions are de-duplicated by key", async () => {
  const p = await toIngestPayload(USER, {
    ...statement,
    trades: [...statement.trades, ...statement.trades],
  });
  assertEquals(p.trades.length, 3);
  assertEquals(
    p.trades.map((t) => t.ib_exec_id),
    ["0000f001.6710a001.01.01", "0000f001.6710a002.01.01", "0000f002.6709b001.01.01"],
  );
  assertEquals(p.trades.filter((t) => t.ib_order_id === "5001").length, 2);
  assertEquals(p.trades[2]?.quantity, -4);
  assertEquals(p.trades[2]?.fifo_pnl_realized, 4.6);
  assertEquals(p.trades[0]?.trade_time, "09:30:01");
});

Deno.test("closed lots of one sale have distinct hashes, stable across calls, and different for another user", async () => {
  const a = await toIngestPayload(USER, statement);
  const b = await toIngestPayload(USER, statement);
  const other = await toIngestPayload("b0000000-0000-4000-8000-00000000000b", statement);
  assertEquals(a.closed_lots.length, 2);
  assertNotEquals(a.closed_lots[0]?.dedupe_hash, a.closed_lots[1]?.dedupe_hash);
  assertEquals(
    a.closed_lots.map((l) => l.dedupe_hash),
    b.closed_lots.map((l) => l.dedupe_hash),
  );
  assertNotEquals(a.closed_lots[0]?.dedupe_hash, other.closed_lots[0]?.dedupe_hash);
  assertEquals(
    a.closed_lots.map((l) => l.quantity),
    [3, 1],
  );
  assertEquals(a.closed_lots.reduce((n, l) => n + l.fifo_pnl_realized, 0).toFixed(2), "4.60");
});

Deno.test("two identical cash rows in one statement keep two hashes, and the same statement hashes the same way again", async () => {
  const row = statement.cashTransactions[0];
  assert(row !== undefined);
  const p = await toIngestPayload(USER, { ...statement, cashTransactions: [row, { ...row }] });
  assertEquals(p.cash.length, 2);
  assertNotEquals(p.cash[0]?.dedupe_hash, p.cash[1]?.dedupe_hash);
  const again = await toIngestPayload(USER, { ...statement, cashTransactions: [row, { ...row }] });
  assertEquals(
    again.cash.map((c) => c.dedupe_hash),
    p.cash.map((c) => c.dedupe_hash),
  );
});

Deno.test("cash, fx, nav and corporate actions are mapped; unknown attributes and raw rows never reach the payload", async () => {
  const p = await toIngestPayload(USER, statement);
  assertEquals(
    p.cash.map((c) => c.category),
    ["dividend", "withholding_tax", "deposit_withdrawal", "fee"],
  );
  assertEquals(p.cash[0]?.occurred_at, "2026-10-10T20:25:00Z");
  assertEquals(p.fx.length, 2);
  assertEquals(
    p.nav.map((n) => n.total),
    [9800.55, 9950.2],
  );
  assertEquals(p.corporate_actions.length, 1);
  assertEquals(p.corporate_actions[0]?.kind, "corporate_action");
  const text = JSON.stringify(p);
  assert(!text.includes("kept-in-raw"));
  assert(!text.includes('"raw"'));
  assert(!text.includes("U1234567"));
});

Deno.test("two identical closed lots of one sale get distinct, re-ingest-stable hashes", async () => {
  const lot = statement.closedLots[0];
  if (!lot) throw new Error("fixture needs a closed lot");
  const doubled = { ...statement, closedLots: [lot, { ...lot }] };
  const a = await toIngestPayload(USER, doubled);
  const b = await toIngestPayload(USER, doubled);
  const hashes = a.closed_lots.map((l) => l.dedupe_hash);
  assertEquals(new Set(hashes).size, 2);
  assertEquals(
    b.closed_lots.map((l) => l.dedupe_hash),
    hashes,
  );
});
