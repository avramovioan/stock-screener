import { describe, expect, it, vi } from "vitest";
import { createNotificationsApi, DEFAULT_TOPICS, NotificationsApiError } from "./notifications-api";

const SUB = {
  endpoint: "https://push.example/e1",
  expirationTime: null,
  keys: { p256dh: "k", auth: "a" },
} as PushSubscriptionJSON;

function fakeClient(result: { data: unknown; error: unknown }) {
  const invoke = vi.fn().mockResolvedValue(result);
  const client = { functions: { invoke } } as unknown as Parameters<
    typeof createNotificationsApi
  >[0];
  return { api: createNotificationsApi(client), invoke };
}

const httpError = (status: number, body: unknown = {}) => ({
  name: "FunctionsHttpError",
  message: "Edge Function returned a non-2xx status code",
  context: new Response(JSON.stringify(body), { status }),
});

describe("createNotificationsApi", () => {
  it("subscribes with the endpoint, keys and topics and returns the stored topics", async () => {
    const { api, invoke } = fakeClient({
      data: { ok: true, topics: { discounts: true, portfolio: false } },
      error: null,
    });
    expect(await api.subscribe(SUB, DEFAULT_TOPICS)).toEqual({
      discounts: true,
      portfolio: false,
    });
    expect(invoke).toHaveBeenCalledWith("push-subscribe", {
      body: {
        action: "subscribe",
        subscription: { endpoint: SUB.endpoint, keys: SUB.keys },
        topics: DEFAULT_TOPICS,
      },
    });
  });

  it("subscribes with the default topics when none are given (subscription change)", async () => {
    const { api, invoke } = fakeClient({ data: { ok: true, topics: DEFAULT_TOPICS }, error: null });
    await api.subscribe(SUB);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ body: { topics: DEFAULT_TOPICS } });
  });

  it("updates the topics of one endpoint", async () => {
    const topics = { discounts: false, portfolio: true };
    const { api, invoke } = fakeClient({ data: { ok: true, topics }, error: null });
    expect(await api.update(SUB.endpoint as string, topics)).toEqual(topics);
    expect(invoke).toHaveBeenCalledWith("push-subscribe", {
      body: { action: "update", endpoint: SUB.endpoint, topics },
    });
  });

  it("reads the status of an endpoint", async () => {
    const { api, invoke } = fakeClient({
      data: { subscribed: true, topics: { discounts: true, portfolio: true } },
      error: null,
    });
    expect(await api.status("https://push.example/e1")).toEqual({
      subscribed: true,
      topics: { discounts: true, portfolio: true },
    });
    expect(invoke).toHaveBeenCalledWith("push-subscribe", {
      body: { action: "status", endpoint: "https://push.example/e1" },
    });
  });

  it("reads an unknown endpoint as not subscribed", async () => {
    const { api } = fakeClient({ data: { subscribed: false, topics: null }, error: null });
    expect(await api.status("x")).toEqual({ subscribed: false, topics: null });
  });

  it("unsubscribes by endpoint", async () => {
    const { api, invoke } = fakeClient({ data: { ok: true }, error: null });
    await api.unsubscribe("https://push.example/e1");
    expect(invoke).toHaveBeenCalledWith("push-subscribe", {
      body: { action: "unsubscribe", endpoint: "https://push.example/e1" },
    });
  });

  it("sends a test to that endpoint only and returns the counts", async () => {
    const { api, invoke } = fakeClient({ data: { ok: true, sent: 1, failed: 0 }, error: null });
    expect(await api.sendTest("https://push.example/e1")).toEqual({ sent: 1, failed: 0 });
    expect(invoke).toHaveBeenCalledWith("push-subscribe", {
      body: { action: "test", endpoint: "https://push.example/e1" },
    });
  });

  it("passes the failure reason and status of a test through", async () => {
    const { api } = fakeClient({
      data: { ok: true, sent: 0, failed: 1, reason: "rejected", status: 403 },
      error: null,
    });
    expect(await api.sendTest("https://push.example/e1")).toEqual({
      sent: 0,
      failed: 1,
      reason: "rejected",
      status: 403,
    });
  });

  it.each([
    [409, "too_many_subscriptions"],
    [404, "not_found"],
    [429, "rate_limited"],
    [400, "invalid"],
    [500, "failed"],
  ])("maps HTTP %i to the reason %s", async (status, reason) => {
    const { api } = fakeClient({ data: null, error: httpError(status) });
    const error = await api.status("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotificationsApiError);
    expect((error as NotificationsApiError).reason).toBe(reason);
  });

  it("maps a failed request without a response to failed", async () => {
    const { api } = fakeClient({ data: null, error: { message: "Failed to send a request" } });
    const error = await api.unsubscribe("x").catch((e: unknown) => e);
    expect((error as NotificationsApiError).reason).toBe("failed");
  });
});
