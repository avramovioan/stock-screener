import { assert, assertEquals } from "@std/assert";
import { testCtx } from "../testing/ctx.ts";
import { createFakeSb, type FakeSb, type Row } from "../testing/fake-sb.ts";
import type { HandlerContext } from "../types.ts";
import { handleIdentity, seedIdentity } from "./identity.ts";

const RUN = "run-today";

const EXCHANGES: Row[] = [
  ["LSE", "United Kingdom", "primary"],
  ["NMS", "United States", "primary"],
  ["NYQ", "United States", "primary"],
  ["EBS", "Switzerland", "primary"],
  ["PAR", "France", "primary"],
  ["NSI", "India", "primary"],
  ["BSE", "India", "primary"],
].map(([code, country, venue]) => ({
  code,
  country,
  timezone: "UTC",
  currencies: ["USD"],
  venue_class: venue,
  screener_enabled: true,
  trading_days: [1, 2, 3, 4, 5],
  session_close_local: "16:00:00",
  max_gap_days: 5,
  us_primary: code === "NMS" || code === "NYQ",
}));

interface SecSpec {
  id: string;
  company: string;
  symbol: string;
  exchange: string;
  name: string;
  canonical?: boolean;
  quoteType?: string;
  volume?: number | null;
  cap?: number;
  financial?: string;
  ccy?: string;
}

function sec(s: SecSpec): Row {
  return {
    id: s.id,
    company_id: s.company,
    yahoo_symbol: s.symbol,
    exchange_code: s.exchange,
    long_name: s.name,
    shares_outstanding: 1000,
    avg_usd_volume_30d: s.volume ?? null,
    first_trade_date: "2000-01-03",
    is_canonical: s.canonical ?? false,
    role: s.canonical ? "canonical" : "other",
    volume_probe_at: "2026-10-14T00:00:00Z",
    currency: "USD",
    currency_major: s.ccy ?? "USD",
    minor_divisor: 1,
    financial_currency: s.financial ?? "USD",
    quote_type: s.quoteType ?? "EQUITY",
    status: "active",
  };
}

function world(
  secs: SecSpec[],
  companies: Array<{ id: string; country: string | null; refreshed?: string | null }>,
): FakeSb {
  const sb = createFakeSb({
    exchanges: EXCHANGES,
    securities: secs.map(sec),
    companies: companies.map((c) => ({
      id: c.id,
      name: c.id,
      country: c.country,
      profile_refreshed_at: c.refreshed === undefined ? "2026-10-10T00:00:00Z" : c.refreshed,
    })),
    market_cap_snapshots: secs.map((s, i) => ({
      id: i + 1,
      scan_run_id: RUN,
      security_id: s.id,
      market_cap_usd: s.cap ?? 6e10,
      quality: "ok",
    })),
    price_series: [],
    security_identity_overrides: [],
    scan_jobs: [],
  });
  sb.rpcs["apply_identity_groups"] = () => ({
    data: { orphans_deleted: 0, orphans_deactivated: 0 },
  });
  return sb;
}

function ctxFor(sb: FakeSb, key: string): HandlerContext & { events: string[] } {
  const ctx = testCtx(sb, {});
  return { ...ctx, job: { ...ctx.job, stage: "identity", key } };
}

interface Group {
  company_id: string;
  member_ids: string[];
  canonical_id: string | null;
  roles: Record<string, string>;
  country: string | null;
  exclusion_reason: string | null;
}
const groupsOf = (sb: FakeSb): Group[] =>
  sb.rpcCalls
    .filter((c) => c.name === "apply_identity_groups")
    .flatMap((c) => c.args["p_groups"] as Group[]);

Deno.test("group: IDEXX whose only line is the London 0J8P.L is excluded (no_primary_listing), not canonical", async () => {
  const sb = world(
    [
      {
        id: "s-iob",
        company: "c-idex",
        symbol: "0J8P.L",
        exchange: "LSE",
        name: "IDEXX Laboratories, Inc.",
        canonical: true,
        volume: 550,
      },
    ],
    [{ id: "c-idex", country: "United States" }],
  );
  const ctx = ctxFor(sb, "group:0");
  const result = await handleIdentity(ctx);
  const [g] = groupsOf(sb);
  assertEquals(g?.canonical_id, null);
  assertEquals(g?.exclusion_reason, "no_primary_listing");
  assertEquals(g?.roles["s-iob"], "secondary_venue");
  assertEquals((result as Record<string, unknown>)["excluded"], { no_primary_listing: 1 });
  assert(ctx.events.includes("companies_excluded"));
});

Deno.test("group: the US line wins over the busier London line and the old IOB canonical is replaced", async () => {
  const sb = world(
    [
      {
        id: "s-iob",
        company: "c-idex",
        symbol: "0J8P.L",
        exchange: "LSE",
        name: "IDEXX Laboratories, Inc.",
        canonical: true,
        volume: 9e9,
      },
      {
        id: "s-us",
        company: "c-idex",
        symbol: "IDXX",
        exchange: "NMS",
        name: "IDEXX Laboratories, Inc.",
        volume: 1e6,
      },
    ],
    [{ id: "c-idex", country: "United States" }],
  );
  await handleIdentity(ctxFor(sb, "group:0"));
  const [g] = groupsOf(sb);
  assertEquals(g?.canonical_id, "s-us");
  assertEquals(g?.exclusion_reason, null);
  assertEquals(g?.roles["s-iob"], "secondary_venue");
});

Deno.test("group: Ericsson with an unknown country and only an IOB line is excluded (country_unknown)", async () => {
  const sb = world(
    [
      {
        id: "s-eric",
        company: "c-eric",
        symbol: "0O86.L",
        exchange: "LSE",
        name: "Telefonaktiebolaget LM Ericsson",
        canonical: true,
      },
    ],
    [{ id: "c-eric", country: null }],
  );
  const result = await handleIdentity(ctxFor(sb, "group:0"));
  assertEquals(groupsOf(sb)[0]?.exclusion_reason, "country_unknown");
  assertEquals((result as Record<string, unknown>)["excluded"], { country_unknown: 1 });
});

Deno.test("group: an unknown country is inferred from the single non-IOB listing", async () => {
  const sb = world(
    [
      {
        id: "s-iob",
        company: "c-sch",
        symbol: "0QOT.L",
        exchange: "LSE",
        name: "Schindler Holding AG",
        canonical: true,
      },
      {
        id: "s-sw",
        company: "c-sch",
        symbol: "SCHN.SW",
        exchange: "EBS",
        name: "Schindler Holding AG",
        volume: 2e7,
      },
    ],
    [{ id: "c-sch", country: null }],
  );
  await handleIdentity(ctxFor(sb, "group:0"));
  const [g] = groupsOf(sb);
  assertEquals(g?.canonical_id, "s-sw");
  assertEquals(g?.exclusion_reason, null);
  assertEquals(g?.country, null); // inferred for the choice only, never written as a fact
});

Deno.test("group: Reliance picks NSE over BSE and a former BSE canonical moves", async () => {
  const sb = world(
    [
      {
        id: "s-bse",
        company: "c-rel",
        symbol: "RELIANCE.BO",
        exchange: "BSE",
        name: "Reliance Industries Limited",
        canonical: true,
        volume: 9e9,
      },
      {
        id: "s-nse",
        company: "c-rel",
        symbol: "RELIANCE.NS",
        exchange: "NSI",
        name: "Reliance Industries Limited",
        volume: 1e9,
      },
    ],
    [{ id: "c-rel", country: "India" }],
  );
  await handleIdentity(ctxFor(sb, "group:0"));
  assertEquals(groupsOf(sb)[0]?.canonical_id, "s-nse");
});

Deno.test("group: a Crédit Agricole bond that Yahoo labels EQUITY is excluded (not_a_share)", async () => {
  const sb = world(
    [
      {
        id: "s-ca",
        company: "c-ca",
        symbol: "ACA.PA",
        exchange: "PAR",
        name: "Crédit Agricole S.A.",
        volume: 1e8,
        cap: 5e10,
      },
      {
        id: "s-bond",
        company: "c-bond",
        symbol: "ACALK.PA",
        exchange: "PAR",
        name: "Crédit Agricole S.A. 1.3% SNR BDS 08/02/2027 EUR1",
        canonical: true,
        cap: 5e10,
      },
    ],
    [
      { id: "c-ca", country: "France" },
      { id: "c-bond", country: "France" },
    ],
  );
  const result = await handleIdentity(ctxFor(sb, "group:0"));
  const groups = groupsOf(sb);
  assertEquals(groups.find((g) => g.member_ids.includes("s-bond"))?.canonical_id, null);
  assertEquals(
    groups.find((g) => g.member_ids.includes("s-bond"))?.exclusion_reason,
    "not_a_share",
  );
  assertEquals(groups.find((g) => g.member_ids.includes("s-ca"))?.canonical_id, "s-ca");
  assertEquals((result as Record<string, unknown>)["excluded"], { not_a_share: 1 });
});

Deno.test("seed: profile and volume jobs skip IOB lines and bonds; an IOB-only company gets no profile call", async () => {
  const sb = world(
    [
      {
        id: "s-iob",
        company: "c-a",
        symbol: "0J8P.L",
        exchange: "LSE",
        name: "IDEXX Laboratories, Inc.",
        canonical: true,
      },
      {
        id: "s-us",
        company: "c-a",
        symbol: "IDXX",
        exchange: "NMS",
        name: "IDEXX Laboratories, Inc.",
        canonical: false,
        volume: 1e6,
      },
      {
        id: "s-only",
        company: "c-b",
        symbol: "0K6F.L",
        exchange: "LSE",
        name: "NetApp, Inc.",
        canonical: true,
      },
    ],
    [
      { id: "c-a", country: null, refreshed: null },
      { id: "c-b", country: null, refreshed: null },
    ],
  );
  const plan = await seedIdentity(testCtx(sb, {}));
  const payloads = plan.payloads ?? [];
  const profileIds = plan.keys.flatMap((k, i) =>
    k.startsWith("profile:") ? (payloads[i] as { securityIds: string[] }).securityIds : [],
  );
  assertEquals(profileIds, ["s-us"]);
});

Deno.test("seed: a company with an unknown country is profiled again although its profile is fresh; a known one is not", async () => {
  const sb = world(
    [
      {
        id: "s-goog",
        company: "c-goog",
        symbol: "GOOGL",
        exchange: "NMS",
        name: "Alphabet Inc.",
        canonical: true,
        volume: 5e9,
      },
      {
        id: "s-aapl",
        company: "c-aapl",
        symbol: "AAPL",
        exchange: "NMS",
        name: "Apple Inc.",
        canonical: true,
        volume: 5e9,
      },
    ],
    [
      { id: "c-goog", country: null, refreshed: "2026-10-10T00:00:00Z" },
      { id: "c-aapl", country: "United States", refreshed: "2026-10-10T00:00:00Z" },
    ],
  );
  const plan = await seedIdentity(testCtx(sb, {}));
  const payloads = plan.payloads ?? [];
  const profileIds = plan.keys.flatMap((k, i) =>
    k.startsWith("profile:") ? (payloads[i] as { securityIds: string[] }).securityIds : [],
  );
  assertEquals(profileIds, ["s-goog"]);
});

Deno.test("group: Accenture (Ireland, ordinary shares on NYSE) is kept; Novo Nordisk (ADR reporting in DKK) is excluded", async () => {
  const sb = world(
    [
      {
        id: "s-acn",
        company: "c-acn",
        symbol: "ACN",
        exchange: "NYQ",
        name: "Accenture plc",
        volume: 1e9,
      },
      {
        id: "s-nvo",
        company: "c-nvo",
        symbol: "NVO",
        exchange: "NYQ",
        name: "Novo Nordisk A/S",
        financial: "DKK",
        canonical: true,
        volume: 9e9,
      },
    ],
    [
      { id: "c-acn", country: "Ireland" },
      { id: "c-nvo", country: "Denmark" },
    ],
  );
  const result = await handleIdentity(ctxFor(sb, "group:0"));
  const groups = groupsOf(sb);
  assertEquals(groups.find((g) => g.company_id === "c-acn")?.canonical_id, "s-acn");
  assertEquals(groups.find((g) => g.company_id === "c-nvo")?.canonical_id, null);
  assertEquals(
    groups.find((g) => g.company_id === "c-nvo")?.exclusion_reason,
    "no_primary_listing",
  );
  assertEquals((result as Record<string, unknown>)["excluded"], { no_primary_listing: 1 });
});

Deno.test("group: Alphabet with a null country infers the United States from GOOGL and GOOG on Nasdaq", async () => {
  const sb = world(
    [
      {
        id: "s-a",
        company: "c-goog",
        symbol: "GOOGL",
        exchange: "NMS",
        name: "Alphabet Inc.",
        volume: 9e9,
      },
      {
        id: "s-b",
        company: "c-goog",
        symbol: "GOOG",
        exchange: "NMS",
        name: "Alphabet Inc.",
        volume: 8e9,
      },
      {
        id: "s-sw",
        company: "c-goog",
        symbol: "GOOGL.SW",
        exchange: "EBS",
        name: "Alphabet Inc.",
        ccy: "CHF",
        volume: 1e6,
      },
    ],
    [{ id: "c-goog", country: null }],
  );
  await handleIdentity(ctxFor(sb, "group:0"));
  const [g] = groupsOf(sb);
  assertEquals(g?.canonical_id, "s-a");
  assertEquals(g?.exclusion_reason, null);
});

function logged(sb: FakeSb, key: string) {
  const base = ctxFor(sb, key);
  const entries: Array<{ event: string; data?: Record<string, unknown>; level?: string }> = [];
  const ctx: HandlerContext = {
    ...base,
    log: (event, data, extra) => {
      entries.push({ event, data, level: extra?.level });
      return Promise.resolve();
    },
  };
  return { ctx, entries };
}

Deno.test("group: two groups of one company keep apart by cap_mismatch share one company id; the later one is split off", async () => {
  // same name, caps 25% apart -> a review pair, so two groups, both resolving to company c-split
  const sb = world(
    [
      {
        id: "s-a",
        company: "c-split",
        symbol: "SPL",
        exchange: "NMS",
        name: "Split Corp",
        canonical: true,
        volume: 9e9,
        cap: 8e10,
      },
      {
        id: "s-b",
        company: "c-split",
        symbol: "SPL.SW",
        exchange: "EBS",
        name: "Split Corp",
        ccy: "CHF",
        volume: 1e6,
        cap: 6e10,
      },
    ],
    [{ id: "c-split", country: "United States" }],
  );
  const { ctx, entries } = logged(sb, "group:0");
  await handleIdentity(ctx);
  const groups = groupsOf(sb);
  assertEquals(groups.length, 2);
  const first = groups.find((g) => g.member_ids.includes("s-a")) as Group;
  const second = groups.find((g) => g.member_ids.includes("s-b")) as Group;
  assertEquals(first.company_id, "c-split");
  assert(second.company_id !== "c-split");
  assertEquals(second.member_ids, ["s-b"]);
  // the split only renames the company: the group's own choice (no home listing here) is untouched
  assertEquals(second.canonical_id, null);
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(second.company_id),
  );
  const splits = entries.filter((e) => e.event === "company_split");
  assertEquals(splits.length, 1);
  assertEquals(splits[0]?.level, "warn");
  assertEquals(splits[0]?.data, {
    company_id: "c-split",
    kept: ["SPL"],
    split: ["SPL.SW"],
  });
});

Deno.test("group: with no duplicate target nothing is split and no company_split is logged", async () => {
  const sb = world(
    [
      {
        id: "s-a",
        company: "c-one",
        symbol: "ONE",
        exchange: "NMS",
        name: "One Corp",
        canonical: true,
        volume: 9e9,
      },
      {
        id: "s-b",
        company: "c-two",
        symbol: "TWO",
        exchange: "NMS",
        name: "Two Corp",
        canonical: true,
        volume: 9e9,
      },
    ],
    [
      { id: "c-one", country: "United States" },
      { id: "c-two", country: "United States" },
    ],
  );
  const { ctx, entries } = logged(sb, "group:0");
  await handleIdentity(ctx);
  assertEquals(
    groupsOf(sb)
      .map((g) => g.company_id)
      .sort(),
    ["c-one", "c-two"],
  );
  assert(!entries.some((e) => e.event === "company_split"));
});

Deno.test("group: a displaced canonical reported by the RPC is logged and returned", async () => {
  const sb = world(
    [
      {
        id: "s-a",
        company: "c-one",
        symbol: "ONE",
        exchange: "NMS",
        name: "One Corp",
        volume: 9e9,
      },
    ],
    [{ id: "c-one", country: "United States" }],
  );
  sb.rpcs["apply_identity_groups"] = () => ({
    data: {
      orphans_deleted: 0,
      orphans_deactivated: 0,
      canonical_displaced: 2,
    },
  });
  const { ctx, entries } = logged(sb, "group:0");
  const result = (await handleIdentity(ctx)) as Record<string, unknown>;
  assertEquals(result["canonicalDisplaced"], 2);
  const e = entries.find((x) => x.event === "canonical_displaced");
  assertEquals(e?.data, { count: 2 });
  assertEquals(e?.level, "warn");
});
