import { describe, expect, it } from "vitest";
import { DEFAULT_SORT, sortPositions } from "./sort";
import { makeRow, NOPX, na, ok, SHEL } from "./test-fixtures";

const AAPL = makeRow();
const tickers = (rows: { ticker: string }[]) => rows.map((r) => r.ticker);

describe("sortPositions", () => {
  it("the default is unrealized P&L ascending: the most negative first, unavailable last", () => {
    expect(DEFAULT_SORT).toEqual({ key: "unrealized", dir: "asc" });
    expect(
      tickers(sortPositions([AAPL, NOPX(), SHEL()], DEFAULT_SORT.key, DEFAULT_SORT.dir)),
    ).toEqual(["SHEL", "AAPL", "NOPX"]);
  });

  it("descending reverses the figures but unavailable stays last in both directions", () => {
    expect(tickers(sortPositions([SHEL(), NOPX(), AAPL], "unrealized", "desc"))).toEqual([
      "AAPL",
      "SHEL",
      "NOPX",
    ]);
    expect(tickers(sortPositions([NOPX(), AAPL, SHEL()], "value", "asc")).at(-1)).toBe("NOPX");
    expect(tickers(sortPositions([NOPX(), AAPL, SHEL()], "value", "desc")).at(-1)).toBe("NOPX");
  });

  it("money columns sort by the base-currency figure, never by mixed native numbers", () => {
    const cheapGbp = SHEL({ valueBase: ok(1000, "EUR") });
    expect(tickers(sortPositions([AAPL, cheapGbp], "value", "asc"))).toEqual(["SHEL", "AAPL"]);
    expect(tickers(sortPositions([AAPL, cheapGbp], "value", "desc"))).toEqual(["AAPL", "SHEL"]);
  });

  it("ticker and name sort case-insensitively; quantity and price numerically", () => {
    const a = makeRow({ id: 5, ticker: "abc", name: "zeta", quantity: 5 });
    expect(tickers(sortPositions([SHEL(), a, AAPL], "ticker", "asc"))).toEqual([
      "AAPL",
      "abc",
      "SHEL",
    ]);
    expect(tickers(sortPositions([SHEL(), a, AAPL], "name", "asc"))).toEqual([
      "AAPL",
      "SHEL",
      "abc",
    ]);
    expect(tickers(sortPositions([SHEL(), a, AAPL], "quantity", "desc"))).toEqual([
      "SHEL",
      "AAPL",
      "abc",
    ]);
    expect(tickers(sortPositions([NOPX(), AAPL, SHEL()], "price", "asc"))).toEqual([
      "SHEL",
      "AAPL",
      "NOPX",
    ]);
  });

  it("tags sort Discounted, none, Premium, Extra premium; Unavailable is last in both directions", () => {
    const rows = [
      makeRow({ id: 1, ticker: "E", tag: "extra_premium" }),
      makeRow({ id: 2, ticker: "U", tag: "unavailable" }),
      makeRow({ id: 3, ticker: "D", tag: "discounted" }),
      makeRow({ id: 4, ticker: "P", tag: "premium" }),
      makeRow({ id: 5, ticker: "N", tag: "none" }),
    ];
    expect(tickers(sortPositions(rows, "tag", "asc"))).toEqual(["D", "N", "P", "E", "U"]);
    expect(tickers(sortPositions(rows, "tag", "desc"))).toEqual(["E", "P", "N", "D", "U"]);
  });

  it("equal values keep a stable order by ticker, and the input is not mutated", () => {
    const a = makeRow({ id: 1, ticker: "B", dailyPnl: ok(1, "USD"), dailyBase: ok(1, "EUR") });
    const b = makeRow({ id: 2, ticker: "A", dailyPnl: ok(1, "USD"), dailyBase: ok(1, "EUR") });
    const input = [a, b];
    expect(tickers(sortPositions(input, "daily", "asc"))).toEqual(["A", "B"]);
    expect(tickers(input)).toEqual(["B", "A"]);
    expect(
      tickers(
        sortPositions(
          [
            makeRow({ ticker: "Z", dailyBase: na("x") }),
            makeRow({ id: 9, ticker: "Y", dailyBase: na("y") }),
          ],
          "daily",
          "asc",
        ),
      ),
    ).toEqual(["Y", "Z"]);
  });
});
