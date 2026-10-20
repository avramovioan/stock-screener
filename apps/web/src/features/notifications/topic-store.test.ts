import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TOPICS, type NotificationsApi } from "./notifications-api";
import { readStoredTopics, resubscribeKeepingTopics, writeStoredTopics } from "./topic-store";

const SUB = { endpoint: "https://push.example/new", keys: { p256dh: "k", auth: "a" } };
const api = (subscribe = vi.fn(async (_s: unknown, t: unknown) => t)) =>
  ({ subscribe }) as unknown as NotificationsApi;

beforeEach(() => localStorage.clear());

describe("stored topics", () => {
  it("round-trips and clears", () => {
    expect(readStoredTopics()).toBeNull();
    writeStoredTopics({ discounts: false, portfolio: true });
    expect(readStoredTopics()).toEqual({ discounts: false, portfolio: true });
    writeStoredTopics(null);
    expect(readStoredTopics()).toBeNull();
  });
  it("ignores garbage", () => {
    localStorage.setItem("device-push-topics", "{nope");
    expect(readStoredTopics()).toBeNull();
  });
});

describe("resubscribeKeepingTopics", () => {
  it("registers the rotated endpoint with the remembered topics", async () => {
    writeStoredTopics({ discounts: false, portfolio: true });
    const subscribe = vi.fn(async (_s: unknown, t: unknown) => t);
    await resubscribeKeepingTopics(api(subscribe), SUB);
    expect(subscribe).toHaveBeenCalledWith(SUB, { discounts: false, portfolio: true });
  });
  it("falls back to the defaults when nothing is stored, and stores the confirmed topics", async () => {
    const subscribe = vi.fn(async (_s: unknown, t: unknown) => t);
    await resubscribeKeepingTopics(api(subscribe), SUB);
    expect(subscribe).toHaveBeenCalledWith(SUB, DEFAULT_TOPICS);
    expect(readStoredTopics()).toEqual(DEFAULT_TOPICS);
  });
});
