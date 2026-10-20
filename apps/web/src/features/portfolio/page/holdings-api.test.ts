import { describe, expect, it, vi } from "vitest";
import { createHoldingsApi } from "./holdings-api";

function fakeClient(positions: unknown[], monitors: unknown[] = [], snapshots?: unknown[]) {
  const select = vi.fn();
  const eq = vi.fn();
  const from = vi.fn((table: string) => {
    if (table === "broker_positions") {
      const chain = {
        select: (cols: string) => {
          select(cols);
          return chain;
        },
        order: () => chain,
        limit: () => Promise.resolve({ data: positions, error: null }),
      };
      return chain;
    }
    if (table === "universe_snapshots" && snapshots !== undefined) {
      const chain = {
        select: () => chain,
        eq: (col: string, v: string) => {
          eq(col, v);
          return chain;
        },
        in: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: snapshots, error: null }),
      };
      return chain;
    }
    return { select: () => Promise.resolve({ data: monitors, error: null }) };
  });
  return { client: { from } as never, select, eq };
}

describe("holdings api", () => {
  it("returns every position: screened ones with their canonical listing, others as held instruments only", async () => {
    const { client, select } = fakeClient([
      {
        conid: 1,
        symbol: "MSFT",
        description: "MICROSOFT CORP",
        currency: "USD",
        listing_exchange: "NASDAQ",
        signal_security_id: "sec-msft",
        securities: { yahoo_symbol: "MSFT" },
      },
      {
        conid: "3",
        symbol: "VUAA",
        description: "VANG S&P500 USDD",
        currency: "USD",
        listing_exchange: "LSEETF",
        signal_security_id: null,
        securities: null,
      },
    ]);
    const links = await createHoldingsApi(client).links();
    expect(select.mock.calls[0]?.[0]).toContain("listing_exchange");
    expect(links.get(1)).toMatchObject({ securityId: "sec-msft", symbol: "MSFT", monitor: null });
    expect(links.get(3)).toEqual({
      conid: 3,
      securityId: null,
      symbol: null,
      isin: null,
      monitor: null,
      held: {
        symbol: "VUAA",
        listingExchange: "LSEETF",
        conid: 3,
        description: "VANG S&P500 USDD",
        currency: "USD",
      },
    });
  });

  it("a screened holding carries its exchange name and the worldwide rank of the latest scan", async () => {
    const { client, eq } = fakeClient(
      [
        {
          conid: 1,
          symbol: "MSFT",
          description: "MICROSOFT CORP",
          isin: "US5949181045",
          currency: "USD",
          listing_exchange: "NASDAQ",
          signal_security_id: "sec-msft",
          securities: { yahoo_symbol: "MSFT", exchange_code: "NMS", exchanges: { name: "NASDAQ" } },
        },
      ],
      [],
      [
        { security_id: "sec-msft", rank: 4, scan_run_id: "run-2" },
        { security_id: "sec-msft", rank: 9, scan_run_id: "run-1" },
      ],
    );
    const links = await createHoldingsApi(client).links();
    expect(eq).toHaveBeenCalledWith("mode", "worldwide");
    expect(links.get(1)).toMatchObject({
      isin: "US5949181045",
      screened: { exchangeCode: "NMS", exchangeName: "NASDAQ", rank: 4 },
    });
  });
});
