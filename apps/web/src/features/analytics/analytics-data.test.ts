import { describe, expect, it, vi } from "vitest";
import {
  fetchAllPages,
  loadAnalyticsData,
  mapCash,
  mapLot,
  mapNav,
  mapPosition,
  mapRate,
} from "./analytics-data";

describe("fetchAllPages: PostgREST returns at most 1,000 rows per request", () => {
  it("reads pages until a short page and concatenates them in order", async () => {
    const page = vi.fn((from: number, to: number) =>
      Promise.resolve({
        data: Array.from({ length: Math.min(to, 2349) - from + 1 }, (_, i) => from + i),
        error: null,
      }),
    );
    const rows = await fetchAllPages<number>(page, 1000);
    expect(rows).toHaveLength(2350);
    expect(rows[0]).toBe(0);
    expect(rows.at(-1)).toBe(2349);
    expect(page.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("an exactly full last page triggers one more (empty) request; an empty table is one request", async () => {
    const full = vi.fn((from: number) =>
      Promise.resolve({
        data: from === 0 ? Array.from({ length: 1000 }, (_, i) => i) : [],
        error: null,
      }),
    );
    expect(await fetchAllPages<number>(full, 1000)).toHaveLength(1000);
    expect(full).toHaveBeenCalledTimes(2);
    const empty = vi.fn(() => Promise.resolve({ data: [], error: null }));
    expect(await fetchAllPages(empty, 1000)).toEqual([]);
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it("an error stops the loading with a message that carries no row data", async () => {
    await expect(
      fetchAllPages(
        () => Promise.resolve({ data: null, error: { message: "secret detail", code: "42501" } }),
        1000,
      ),
    ).rejects.toThrow("Could not load the statement history.");
  });
});

describe("row mappers coerce PostgREST numerics and keep the dedupe key", () => {
  it("closed lot", () => {
    expect(
      mapLot({
        conid: 100002,
        currency: "GBP",
        quantity: "3",
        cost_basis: "75",
        proceeds: "79.5",
        fifo_pnl_realized: "4.2",
        close_date: "2026-10-08",
        fx_rate_to_base: "1.15",
        dedupe_hash: "h1",
      }),
    ).toEqual({
      conid: 100002,
      ccy: "GBP",
      qty: 3,
      costBasis: 75,
      proceeds: 79.5,
      realizedPnl: 4.2,
      closeDate: "2026-10-08",
      fxToBase: 1.15,
      key: "h1",
    });
    expect(
      mapLot({
        conid: 1,
        currency: "USD",
        quantity: 1,
        cost_basis: 1,
        proceeds: null,
        fifo_pnl_realized: 0,
        close_date: "2026-10-08",
        fx_rate_to_base: null,
        dedupe_hash: "h",
      }).fxToBase,
    ).toBeNull();
  });

  it("cash transaction uses the date part of occurred_at", () => {
    expect(
      mapCash({
        occurred_at: "2026-10-10T20:25:00+00:00",
        currency: "USD",
        amount: "2.6",
        category: "dividend",
        conid: 100001,
        fx_rate_to_base: "0.92",
      }),
    ).toEqual({
      date: "2026-10-10",
      ccy: "USD",
      amount: 2.6,
      category: "dividend",
      conid: 100001,
      fxToBase: 0.92,
    });
  });

  it("statement position, NAV row and FX rate", () => {
    expect(
      mapPosition({
        currency: "USD",
        cost_basis_money: "2001.7",
        fifo_pnl_unrealized: "298.3",
        fx_rate_to_base: "0.92",
      }),
    ).toEqual({
      ccy: "USD",
      costBasisMoney: 2001.7,
      fifoUnrealized: 298.3,
      fxToBase: 0.92,
    });
    expect(
      mapPosition({
        currency: "USD",
        cost_basis_money: null,
        fifo_pnl_unrealized: null,
        fx_rate_to_base: null,
      }),
    ).toEqual({
      ccy: "USD",
      costBasisMoney: null,
      fifoUnrealized: null,
      fxToBase: null,
    });
    expect(mapNav({ report_date: "2026-10-14", currency: "EUR", total: "9950.20" })).toEqual({
      date: "2026-10-14",
      total: 9950.2,
      ccy: "EUR",
    });
    expect(
      mapRate({ rate_date: "2026-10-14", from_ccy: "USD", to_ccy: "EUR", rate: "0.92" }),
    ).toEqual({
      rateDate: "2026-10-14",
      fromCcy: "USD",
      toCcy: "EUR",
      rate: 0.92,
    });
  });
});

describe("loadAnalyticsData fails closed", () => {
  type Result = { data?: unknown; error?: unknown; count?: number | null };
  function client(failing: "transfers" | "latest" | "none") {
    const chain = (table: string): Record<string, unknown> => {
      const result = (): Result => {
        if (table === "broker_corporate_actions")
          return failing === "transfers" ? { error: { message: "x" } } : { count: 0, error: null };
        if (table === "broker_connections") return { data: null, error: null };
        if (table === "broker_positions" && failing === "latest")
          return { error: { message: "x" } };
        return { data: [], error: null };
      };
      const self: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit", "eq", "range", "maybeSingle"])
        self[m] = () => self;
      // biome-ignore lint/suspicious/noThenProperty: the Supabase query builder is awaitable
      self["then"] = (ok: (v: Result) => unknown) => Promise.resolve(result()).then(ok);
      return self;
    };
    return { from: (t: string) => chain(t) } as never;
  }

  it("resolves when nothing fails", async () => {
    await expect(loadAnalyticsData(client("none"))).resolves.toMatchObject({
      hasUnvaluedTransfers: false,
    });
  });
  it("throws when the transfers query fails instead of assuming there are none", async () => {
    await expect(loadAnalyticsData(client("transfers"))).rejects.toThrow(
      "Could not load the statement history.",
    );
  });
  it("throws when the latest-positions query fails", async () => {
    await expect(loadAnalyticsData(client("latest"))).rejects.toThrow(
      "Could not load the statement history.",
    );
  });
});
