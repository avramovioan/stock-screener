import { assertEquals, assertRejects } from "@std/assert";
import { telegramSendLatest } from "./telegram_send_latest.ts";

const sb = (data: unknown, error: { message: string } | null = null) =>
  ({ rpc: (_fn: string) => Promise.resolve({ data, error }) }) as never;

Deno.test("telegram_send_latest: not configured answers without touching the database", async () => {
  const r = await telegramSendLatest({
    sb: { rpc: () => Promise.reject(new Error("must not be called")) } as never,
    configured: false,
  });
  assertEquals(r, { queued: false, reason: "not_configured" });
});

Deno.test("telegram_send_latest: a queued digest returns its id, date and the timing note", async () => {
  const r = await telegramSendLatest({
    sb: sb({ queued: true, digest_id: "d1", scan_date: "2026-10-21" }),
    configured: true,
  });
  assertEquals(r, {
    queued: true,
    digest_id: "d1",
    scan_date: "2026-10-21",
    note: "sends within a minute",
  });
});

Deno.test("telegram_send_latest: already sent and no ready digest are answers, not errors", async () => {
  assertEquals(
    await telegramSendLatest({
      sb: sb({ queued: false, reason: "already_sent" }),
      configured: true,
    }),
    { queued: false, reason: "already_sent" },
  );
  assertEquals(
    await telegramSendLatest({
      sb: sb({ queued: false, reason: "no_ready_digest" }),
      configured: true,
    }),
    { queued: false, reason: "no_ready_digest" },
  );
});

Deno.test("telegram_send_latest: a database error is thrown", async () => {
  await assertRejects(
    () => telegramSendLatest({ sb: sb(null, { message: "boom" }), configured: true }),
    Error,
    "boom",
  );
});
