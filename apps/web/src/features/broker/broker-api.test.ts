import { describe, expect, it, vi } from "vitest";
import { createBrokerApi } from "./broker-api";

const conn = { id: "c1", status: "linked", account_id_masked: "U***4567" };
const run = {
  id: "r1",
  kind: "verify",
  state: "done",
  error_code: null,
  error_message: null,
  rows_summary: {},
};

function api(res: Response | Error) {
  const call = vi.fn((_body: Record<string, unknown>) =>
    res instanceof Error ? Promise.reject(res) : Promise.resolve(res),
  );
  return { call, client: createBrokerApi({ readSnapshot: vi.fn(), call }) };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("broker api", () => {
  it("link posts the action with the token only in the request body and returns the safe connection", async () => {
    const { client, call } = api(json({ ok: true, connection: conn, run }));
    const out = await client.link({
      token: "987654321012345678901234",
      queryId: "123456",
      tokenExpiresOn: "2027-06-01",
    });
    expect(call).toHaveBeenCalledWith({
      action: "link",
      token: "987654321012345678901234",
      queryId: "123456",
      tokenExpiresOn: "2027-06-01",
    });
    expect(out).toEqual({ ok: true, connection: conn, run });
    expect(JSON.stringify(out)).not.toContain("987654321012345678901234");
  });

  it("test, sync and unlink map to their actions", async () => {
    const { client, call } = api(json({ ok: true, connection: conn, run }));
    await client.test();
    await client.sync();
    await client.unlink({ deleteData: true });
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      { action: "test" },
      { action: "sync" },
      { action: "unlink", deleteData: true },
    ]);
  });

  it("maps HTTP outcomes: invalid input with the field, cooldown with Retry-After, busy, not linked, failure", async () => {
    expect(
      await api(
        json(
          { error: "invalid_input", field: "queryId", message: "The Query ID is a number." },
          400,
        ),
      ).client.link({ token: "x", queryId: "y", tokenExpiresOn: "z" }),
    ).toEqual({
      ok: false,
      kind: "invalid_input",
      field: "queryId",
      message: "The Query ID is a number.",
    });
    expect(
      await api(
        json({ error: "cooldown", retryAfterSeconds: 321 }, 429, { "retry-after": "321" }),
      ).client.sync(),
    ).toEqual({ ok: false, kind: "cooldown", retryAfterSeconds: 321 });
    expect(await api(json({ error: "run_in_progress" }, 409)).client.test()).toEqual({
      ok: false,
      kind: "busy",
    });
    expect(await api(json({ error: "not_linked" }, 409)).client.test()).toEqual({
      ok: false,
      kind: "not_linked",
    });
    expect(await api(json({ error: "internal_error" }, 500)).client.sync()).toEqual({
      ok: false,
      kind: "failed",
      message: "The request failed (HTTP 500).",
    });
  });

  it("a network error is a failure without raw details", async () => {
    const out = await api(new TypeError("Failed to fetch https://x?t=SECRET")).client.sync();
    expect(out).toEqual({
      ok: false,
      kind: "failed",
      message: "Network error: could not reach the server.",
    });
  });
});
