import type { TelegramResult } from "@adapters/telegram.ts";
import { assertEquals, assertFalse } from "@std/assert";
import { telegramTest } from "./telegram_probe.ts";

const TEXT = "Test message from the stock screener.";

function sender(result: TelegramResult) {
  const sent: string[] = [];
  return {
    sent,
    send: (text: string) => {
      sent.push(text);
      return Promise.resolve(result);
    },
  };
}

Deno.test("telegram_test: sends the fixed test text to the group and reports success", async () => {
  const s = sender({ ok: true, messageId: 3 });
  assertEquals(await telegramTest({ telegram: s }), {
    ok: true,
    telegram_status: 200,
    description: "sent",
  });
  assertEquals(s.sent, [TEXT]);
});

Deno.test("telegram_test: not configured is an answer, not an error", async () => {
  assertEquals(await telegramTest({ telegram: null }), {
    ok: false,
    telegram_status: null,
    description: "not_configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID",
  });
});

Deno.test("telegram_test: a failure returns Telegram's own status and description", async () => {
  const s = sender({
    ok: false,
    kind: "rejected",
    status: 400,
    description: "Bad Request: chat not found",
  });
  assertEquals(await telegramTest({ telegram: s }), {
    ok: false,
    telegram_status: 400,
    description: "Bad Request: chat not found",
  });
});

Deno.test("telegram_test: a network failure says so without any detail", async () => {
  const r = await telegramTest({ telegram: sender({ ok: false, kind: "network" }) });
  assertEquals(r, { ok: false, telegram_status: null, description: "network_error" });
  assertFalse(JSON.stringify(r).includes("bot"));
});
