import { assertEquals, assertRejects } from "@std/assert";
import { pushSendLatest } from "./push_send_latest.ts";

const sb = (data: unknown, error: { message: string } | null = null) =>
  ({ rpc: (_fn: string) => Promise.resolve({ data, error }) }) as never;

Deno.test("push_send_latest: a queued digest answers ok with its counts", async () => {
  assertEquals(
    await pushSendLatest({
      sb: sb({ digest_id: "d1", scan_date: "2026-10-21", queued: 3, already_sent: 1 }),
    }),
    { ok: true, digest_id: "d1", scan_date: "2026-10-21", queued: 3, already_sent: 1 },
  );
});

Deno.test("push_send_latest: no ready digest is an answer, not an error", async () => {
  assertEquals(await pushSendLatest({ sb: sb({ reason: "no_ready_digest" }) }), {
    ok: true,
    queued: 0,
    reason: "no_ready_digest",
  });
});

Deno.test("push_send_latest: a database error is thrown", async () => {
  await assertRejects(() => pushSendLatest({ sb: sb(null, { message: "boom" }) }), Error, "boom");
});
