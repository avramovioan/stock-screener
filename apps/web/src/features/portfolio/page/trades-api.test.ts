import { describe, expect, it, vi } from "vitest";
import {
  BOND_SYMBOL,
  createTradesApi,
  FX_SYMBOL,
  NO_FILTERS,
  TRADES_PAGE_SIZE,
} from "./trades-api";

function fakeClient(result: { data: unknown; error: unknown; count: number | null }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "order", "range"]) {
    chain[name] = vi.fn((...args: unknown[]) => {
      calls.push([name, ...args]);
      return name === "range" ? Promise.resolve(result) : chain;
    });
  }
  return { client: { from: vi.fn(() => chain) } as never, calls };
}

describe("trades api", () => {
  it("reads executions newest first (date, time, id) one page at a time with an exact count", async () => {
    const { client, calls } = fakeClient({
      data: [
        {
          id: 1,
          ib_exec_id: "e1",
          symbol: "AAPL",
          quantity: "-4",
          trade_price: "26.5",
          ib_commission: "-0.4",
          net_cash: "105.6",
          fifo_pnl_realized: "4.6",
        },
      ],
      error: null,
      count: 61,
    });
    const out = await createTradesApi(client).page(2);
    expect(
      calls
        .filter(([n]) => n === "order")
        .map(([, col, opts]) => [col, (opts as { ascending: boolean }).ascending]),
    ).toEqual([
      ["trade_date", false],
      ["trade_time", false],
      ["id", false],
    ]);
    expect(calls.find(([n]) => n === "range")?.slice(1)).toEqual([
      2 * TRADES_PAGE_SIZE,
      3 * TRADES_PAGE_SIZE - 1,
    ]);
    expect(out.total).toBe(61);
    expect(out.rows[0]).toMatchObject({
      quantity: -4,
      trade_price: 26.5,
      ib_commission: -0.4,
      net_cash: 105.6,
      fifo_pnl_realized: 4.6,
    });
  });

  it("numeric columns arrive as strings or numbers and nulls stay null", async () => {
    const { client } = fakeClient({
      data: [
        {
          id: 2,
          ib_exec_id: "e2",
          symbol: "X",
          quantity: 3,
          trade_price: 1,
          ib_commission: null,
          net_cash: null,
          fifo_pnl_realized: null,
        },
      ],
      error: null,
      count: 1,
    });
    const out = await createTradesApi(client).page(0);
    expect(out.rows[0]).toMatchObject({
      quantity: 3,
      ib_commission: null,
      net_cash: null,
      fifo_pnl_realized: null,
    });
  });

  it("an error is thrown without row data", async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: "boom", code: "42501" },
      count: null,
    });
    await expect(createTradesApi(client).page(0)).rejects.toThrow(
      "Could not load the trade history.",
    );
  });

  describe("filters", () => {
    function recorder(rows: unknown[] = []) {
      const calls: Array<[string, ...unknown[]]> = [];
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get:
            (_t, name: string) =>
            (...args: unknown[]) => {
              calls.push([name, ...args]);
              return name === "range"
                ? Promise.resolve({ data: rows, error: null, count: 3 })
                : chain;
            },
        },
      );
      return { client: { from: () => chain } as never, calls };
    }
    const names = (calls: Array<[string, ...unknown[]]>, n: string) =>
      calls.filter(([c]) => c === n).map(([, ...a]) => a);

    it("without filters adds none of the filter clauses", async () => {
      const { client, calls } = recorder();
      await createTradesApi(client).page(0, NO_FILTERS);
      for (const n of ["or", "eq", "gte", "lte", "not", "filter", "like"])
        expect(names(calls, n)).toEqual([]);
    });

    it("symbol or name is a case-insensitive ilike on both columns, with list punctuation stripped", async () => {
      const { client, calls } = recorder();
      await createTradesApi(client).page(0, { ...NO_FILTERS, q: " Micro,soft(x) " });
      expect(names(calls, "or")).toEqual([
        ["symbol.ilike.*Microsoftx*,description.ilike.*Microsoftx*"],
      ]);
    });

    it("side and currency are exact matches, from and to bound the trade date inclusively", async () => {
      const { client, calls } = recorder();
      await createTradesApi(client).page(0, {
        ...NO_FILTERS,
        side: "SELL",
        ccy: "USD",
        from: "2026-01-01",
        to: "2026-10-19",
      });
      expect(names(calls, "eq")).toEqual([
        ["buy_sell", "SELL"],
        ["currency", "USD"],
      ]);
      expect(names(calls, "gte")).toEqual([["trade_date", "2026-01-01"]]);
      expect(names(calls, "lte")).toEqual([["trade_date", "2026-10-19"]]);
    });

    it("type Currency (FX) is the AAA.BBB symbol pattern", async () => {
      const { client, calls } = recorder();
      await createTradesApi(client).page(0, { ...NO_FILTERS, type: "fx" });
      expect(names(calls, "filter")).toEqual([["symbol", "match", "^[A-Z]{3}\\.[A-Z]{3}$"]]);
    });

    it("type Stocks and ETFs is everything that is neither FX nor a bond; Bonds is the bond symbol shape", async () => {
      const stocks = recorder();
      await createTradesApi(stocks.client).page(0, { ...NO_FILTERS, type: "stocks" });
      expect(names(stocks.calls, "not")).toEqual([
        ["symbol", "match", "^[A-Z]{3}\\.[A-Z]{3}$"],
        ["symbol", "match", BOND_SYMBOL],
      ]);
      const bonds = recorder();
      await createTradesApi(bonds.client).page(0, { ...NO_FILTERS, type: "bonds" });
      expect(names(bonds.calls, "filter")).toEqual([["symbol", "match", BOND_SYMBOL]]);
    });

    it("the type patterns classify symbols: share classes are stocks, rate or maturity symbols are bonds", () => {
      const fx = new RegExp(FX_SYMBOL);
      const bond = new RegExp(BOND_SYMBOL);
      const type = (sym: string) => (fx.test(sym) ? "fx" : bond.test(sym) ? "bonds" : "stocks");
      expect(type("BRK B")).toBe("stocks");
      expect(type("BF B")).toBe("stocks");
      expect(type("BRK.B")).toBe("stocks");
      expect(type("T 4.5 02/15/36")).toBe("bonds");
      expect(type("IBM 3.3 05/15/26")).toBe("bonds");
      expect(type("EUR.USD")).toBe("fx");
      expect(type("AAPL")).toBe("stocks");
    });

    it("lists the distinct currencies seen, sorted", async () => {
      const chain = {
        select: () => chain,
        limit: () =>
          Promise.resolve({
            data: [
              { currency: "USD" },
              { currency: "EUR" },
              { currency: "USD" },
              { currency: "CHF" },
            ],
            error: null,
          }),
      };
      const out = await createTradesApi({ from: () => chain } as never).currencies();
      expect(out).toEqual(["CHF", "EUR", "USD"]);
    });
  });
});
