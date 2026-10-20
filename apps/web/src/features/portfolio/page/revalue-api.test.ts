import { describe, expect, it, vi } from "vitest";
import { createRevalueApi } from "./revalue-api";

function api(res: Response | Error, token: string | null = "jwt") {
  const fetchImpl = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  return {
    fetchImpl,
    api: createRevalueApi({
      url: "http://x/functions/v1/portfolio-refresh",
      anonKey: "anon",
      getAccessToken: async () => token,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("revalue api", () => {
  it("posts the revalue action with the user's JWT", async () => {
    const { api: a, fetchImpl } = api(json({ ok: true }));
    expect(await a.revalue(100001)).toEqual({ kind: "ok" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x/functions/v1/portfolio-refresh");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body as string)).toEqual({ action: "revalue", conid: 100001 });
  });

  it("a 429 carries next_allowed_at", async () => {
    const { api: a } = api(json({ ok: false, next_allowed_at: "2026-10-20T07:00:00Z" }, 429));
    expect(await a.revalue(1)).toEqual({ kind: "cooldown", nextAllowedAt: "2026-10-20T07:00:00Z" });
  });

  it("other failures are an error with a message", async () => {
    expect((await api(json({}, 500)).api.revalue(1)).kind).toBe("error");
    expect((await api(new Error("down")).api.revalue(1)).kind).toBe("error");
    expect((await api(json({ ok: true }), null).api.revalue(1)).kind).toBe("error");
    expect((await api(json({ ok: false }, 200)).api.revalue(1)).kind).toBe("error");
  });
});
