import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestResearch } from "./research-request-api";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "http://example.test");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-123");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const reply = (status: number, body: unknown) =>
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("requestResearch", () => {
  it("posts the security id to the research-request function with the public headers", async () => {
    reply(200, { ok: true, report_id: "r1", started_at: "2026-10-19T10:00:00Z" });
    await requestResearch("sec-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://example.test/functions/v1/research-request");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ security_id: "sec-1" });
    expect(init.headers).toEqual({
      apikey: "anon-key-123",
      Authorization: "Bearer anon-key-123",
      "Content-Type": "application/json",
    });
  });

  it("returns the accepted report", async () => {
    reply(200, { ok: true, report_id: "r1", started_at: "2026-10-19T10:00:00Z" });
    expect(await requestResearch("sec-1")).toEqual({
      ok: true,
      reportId: "r1",
      startedAt: "2026-10-19T10:00:00Z",
    });
  });

  it("accepts a queued answer: report_id null, the worker creates the report later", async () => {
    reply(200, { ok: true, report_id: null, started_at: "2026-10-19T10:00:00Z" });
    expect(await requestResearch("sec-1")).toEqual({
      ok: true,
      reportId: null,
      startedAt: "2026-10-19T10:00:00Z",
    });
  });

  it("still treats ok without a started_at as try_later", async () => {
    reply(200, { ok: true, report_id: null });
    expect(await requestResearch("sec-1")).toEqual({
      ok: false,
      reason: "try_later",
      nextAllowedAt: null,
    });
  });

  it("maps a 4xx reason, with the next allowed time when the server sends one", async () => {
    reply(429, { ok: false, reason: "cooldown", next_allowed_at: "2026-10-22T10:00:00Z" });
    expect(await requestResearch("sec-1")).toEqual({
      ok: false,
      reason: "cooldown",
      nextAllowedAt: "2026-10-22T10:00:00Z",
    });
    reply(429, { ok: false, reason: "network_limit" });
    expect(await requestResearch("sec-1")).toEqual({
      ok: false,
      reason: "network_limit",
      nextAllowedAt: null,
    });
  });

  it("an in_flight answer carries the running scan's start and who asked", async () => {
    reply(409, {
      ok: false,
      reason: "in_flight",
      started_at: "2026-10-19T10:00:00Z",
      requested_by: "visitor",
    });
    expect(await requestResearch("sec-1")).toEqual({
      ok: false,
      reason: "in_flight",
      nextAllowedAt: null,
      startedAt: "2026-10-19T10:00:00Z",
      requestedBy: "visitor",
    });
    reply(409, { ok: false, reason: "in_flight", started_at: null, requested_by: null });
    expect(await requestResearch("sec-1")).toEqual({
      ok: false,
      reason: "in_flight",
      nextAllowedAt: null,
      startedAt: null,
      requestedBy: null,
    });
    reply(409, { ok: false, reason: "in_flight", requested_by: "robot" });
    expect(await requestResearch("sec-1")).toMatchObject({ startedAt: null, requestedBy: null });
  });

  it("treats an unknown reason, a non-JSON body or a network failure as try_later", async () => {
    reply(400, { ok: false, reason: "something_new" });
    expect(await requestResearch("sec-1")).toMatchObject({ ok: false, reason: "try_later" });
    fetchMock.mockResolvedValue(new Response("<html>", { status: 502 }));
    expect(await requestResearch("sec-1")).toMatchObject({ ok: false, reason: "try_later" });
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await requestResearch("sec-1")).toMatchObject({ ok: false, reason: "try_later" });
  });
});
