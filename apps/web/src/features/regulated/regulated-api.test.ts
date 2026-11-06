import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/features/screening/errors";
import { checkRegulated, EsmaUnavailableError } from "./regulated-api";

const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession } } }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "http://example.test");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-123");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  getSession.mockResolvedValue({ data: { session: { access_token: "jwt-abc" } } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("checkRegulated", () => {
  it("POSTs isin and mic with the anon key headers and returns the body", async () => {
    const body = { isin: "IE00BMFKG444", mic: "XETR", verdict: "regulated" };
    fetchMock.mockResolvedValue(json(body));
    await expect(checkRegulated("IE00BMFKG444", "XETR")).resolves.toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://example.test/functions/v1/esma-regulated");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ isin: "IE00BMFKG444", mic: "XETR" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      apikey: "anon-key-123",
      Authorization: "Bearer jwt-abc",
      "Content-Type": "application/json",
    });
  });

  it("maps 502 esma-unavailable to EsmaUnavailableError with the manual links", async () => {
    const manualUrls = { venues: "https://a.test/v", instruments: "https://a.test/i" };
    fetchMock.mockResolvedValue(json({ error: "esma-unavailable", manualUrls }, 502));
    const err = await checkRegulated("IE00BMFKG444", "XETR").catch((e) => e);
    expect(err).toBeInstanceOf(EsmaUnavailableError);
    expect(err.manualUrls).toEqual(manualUrls);
  });

  it("maps 429 to rate_limited and 400 to a server ApiError", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "slow down" }, 429));
    expect(await checkRegulated("a", "b").catch((e) => e)).toMatchObject({ kind: "rate_limited" });
    fetchMock.mockResolvedValueOnce(json({ error: "bad isin" }, 400));
    const err = await checkRegulated("a", "b").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
  });

  it("maps 401 to an ApiError with status 401", async () => {
    fetchMock.mockResolvedValue(json({ error: "unauthorized" }, 401));
    expect(await checkRegulated("a", "b").catch((e) => e)).toMatchObject({ status: 401 });
  });

  it("maps a network failure to a network ApiError", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await checkRegulated("a", "b").catch((e) => e)).toMatchObject({ kind: "network" });
  });
});
