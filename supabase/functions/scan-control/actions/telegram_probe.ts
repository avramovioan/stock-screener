import type { TelegramResult } from "../../_shared/adapters/telegram.ts";

export interface TelegramProbeResult {
  ok: boolean;
  /** Telegram's HTTP status; null when nothing was sent (not configured) or the network failed */
  telegram_status: number | null;
  description: string;
}

/** Operator action `telegram_test`: one fixed message to the configured group, and Telegram's own answer (never the token). */
export async function telegramTest(deps: {
  telegram: { send(text: string): Promise<TelegramResult> } | null;
}): Promise<TelegramProbeResult> {
  if (deps.telegram === null)
    return {
      ok: false,
      telegram_status: null,
      description: "not_configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID",
    };
  const r = await deps.telegram.send("Test message from the stock screener.");
  if (r.ok) return { ok: true, telegram_status: 200, description: "sent" };
  if (r.kind === "network")
    return { ok: false, telegram_status: null, description: "network_error" };
  return {
    ok: false,
    telegram_status: r.status ?? null,
    description: r.description ?? `telegram_${r.kind}`,
  };
}
