import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchChartBySymbol, fetchQuotes, fetchQuotesDetailed, searchSymbols } from "./quotes-api";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "http://example.test");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-123");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ hits: [], quotes: [] })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function sentHeaders(): Record<string, string> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
  return init.headers as Record<string, string>;
}

describe("quotes-api request headers", () => {
  it("sends apikey and bearer anon key and nothing secret on every call", async () => {
    await searchSymbols("sap");
    await fetchQuotes(["SAP.DE"]);
    await fetchChartBySymbol("SAP.DE");
    for (const call of fetchMock.mock.calls) {
      const h = (call[1] as RequestInit).headers as Record<string, string>;
      expect(Object.keys(h).sort()).toEqual(["Authorization", "Content-Type", "apikey"]);
      expect(h["apikey"]).toBe("anon-key-123");
      expect(h["Authorization"]).toBe("Bearer anon-key-123");
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("targets the quotes function", async () => {
    await searchSymbols("a b");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://example.test/functions/v1/quotes/search?q=a%20b",
    );
    expect(sentHeaders()["apikey"]).toBe("anon-key-123");
  });
  it("makes no request for an empty symbol list", async () => {
    await expect(fetchQuotes([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchQuotesDetailed", () => {
  it("keeps missing and unavailable apart and fetchQuotes still returns only the quotes", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            quotes: [{ symbol: "MSFT" }],
            missing: ["NOPE"],
            unavailable: ["SAP.DE"],
            fetchedAt: "2026-10-15T08:00:00Z",
            stale: true,
          }),
        ),
    );
    const r = await fetchQuotesDetailed(["MSFT", "NOPE", "SAP.DE"]);
    expect(r.missing).toEqual(["NOPE"]);
    expect(r.unavailable).toEqual(["SAP.DE"]);
    expect(r.stale).toBe(true);
    expect((await fetchQuotes(["MSFT"])).map((q) => q.symbol)).toEqual(["MSFT"]);
  });
  it("defaults the new fields for an older response shape", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ quotes: [] })));
    const r = await fetchQuotesDetailed(["MSFT"]);
    expect(r.unavailable).toEqual([]);
    expect(r.missing).toEqual([]);
  });
  it("503 busy and 502 upstream surface as thrown server errors", async () => {
    for (const [status, error] of [
      [503, "busy, retry shortly"],
      [502, "upstream unavailable"],
    ] as const) {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error }), { status }));
      await expect(fetchQuotesDetailed(["MSFT"])).rejects.toMatchObject({ status, message: error });
    }
  });
});
