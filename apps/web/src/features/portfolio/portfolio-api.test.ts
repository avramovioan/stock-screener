import { describe, expect, it, vi } from "vitest";
import { CooldownError, createPortfolioApi, NotLinkedError, RefreshFailure } from "./portfolio-api";

const body = { serverTime: "2026-10-15T07:00:00.000Z", view: { positions: [] } };

function api(res: Response | Error, token: string | null = "jwt") {
  const fetchImpl = vi.fn(() =>
    res instanceof Error ? Promise.reject(res) : Promise.resolve(res),
  );
  return {
    fetchImpl,
    client: createPortfolioApi({
      url: "https://p.test/functions/v1/portfolio-refresh",
      anonKey: "anon",
      getAccessToken: () => Promise.resolve(token),
      fetchImpl: fetchImpl as never,
      now: () => 42,
    }),
  };
}

describe("portfolio api", () => {
  it("GET sends the bearer token and the anon key and stamps the receipt time", async () => {
    const { client, fetchImpl } = api(new Response(JSON.stringify(body), { status: 200 }));
    const out = await client.get();
    expect(out.receivedAtMs).toBe(42);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://p.test/functions/v1/portfolio-refresh");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer jwt");
    expect((init.headers as Record<string, string>)["apikey"]).toBe("anon");
  });

  it("manual refresh is a POST with manual:true", async () => {
    const { client, fetchImpl } = api(new Response(JSON.stringify(body), { status: 200 }));
    await client.refresh();
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect([init.method, init.body]).toEqual(["POST", JSON.stringify({ manual: true })]);
  });

  it("429 becomes a CooldownError with the Retry-After seconds", async () => {
    const { client } = api(
      new Response(JSON.stringify({ error: "cooldown", retryAfterSeconds: 41 }), {
        status: 429,
        headers: { "retry-after": "41" },
      }),
    );
    await expect(client.refresh()).rejects.toMatchObject({
      name: "CooldownError",
      retryAfterSeconds: 41,
    });
    await expect(api(new Response("{}", { status: 429 })).client.refresh()).rejects.toBeInstanceOf(
      CooldownError,
    );
  });

  it("409 is NotLinkedError, other statuses and network errors are RefreshFailure with no raw details", async () => {
    await expect(api(new Response("{}", { status: 409 })).client.get()).rejects.toBeInstanceOf(
      NotLinkedError,
    );
    const failure = await api(new Response("secret details", { status: 500 }))
      .client.get()
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RefreshFailure);
    expect(String((failure as Error).message)).not.toContain("secret");
    await expect(api(new TypeError("Failed to fetch")).client.get()).rejects.toMatchObject({
      status: null,
    });
  });

  it("no session means no request", async () => {
    const { client, fetchImpl } = api(new Response("{}"), null);
    await expect(client.get()).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
