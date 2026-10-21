/**
 * Telegram Bot API, sendMessage only. The bot token sits in the request URL, so nothing here logs a URL, a request or an error
 * message of the network layer; a result carries a status class and Telegram's own description (with the token removed).
 */

const API_HOST = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;

export interface TelegramEnv {
  botToken: string;
  chatId: string;
}

export type TelegramResult =
  | { ok: true; messageId: number }
  | {
      ok: false;
      kind: "rate_limited" | "server" | "rejected" | "network";
      status?: number;
      retryAfterSec?: number;
      description?: string;
    };

export interface TelegramDeps {
  /** test seam */
  fetchImpl?: typeof fetch;
}

/** The two secrets, or null when either is missing: the feature is off and nothing fails. */
export function loadTelegramEnv(
  get: (name: string) => string | undefined = (n) => Deno.env.get(n),
): TelegramEnv | null {
  const botToken = (get("TELEGRAM_BOT_TOKEN") ?? "").trim();
  const chatId = (get("TELEGRAM_CHAT_ID") ?? "").trim();
  return botToken === "" || chatId === "" ? null : { botToken, chatId };
}

export async function sendTelegramMessage(
  env: TelegramEnv,
  text: string,
  deps: TelegramDeps = {},
): Promise<TelegramResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${API_HOST}/bot${env.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: "network" }; // the error text can contain the URL, hence the token
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // not JSON (a gateway page): the status alone decides
  }
  const rec = (typeof body === "object" && body !== null ? body : {}) as {
    ok?: unknown;
    result?: { message_id?: unknown };
    description?: unknown;
    parameters?: { retry_after?: unknown };
  };
  const messageId = rec.result?.message_id;
  if (response.ok && rec.ok === true && typeof messageId === "number")
    return { ok: true, messageId };
  const description =
    typeof rec.description === "string"
      ? rec.description.split(env.botToken).join("[token]").slice(0, 300)
      : undefined;
  const withDescription = description === undefined ? {} : { description };
  if (response.status === 429) {
    const retry = rec.parameters?.retry_after;
    return {
      ok: false,
      kind: "rate_limited",
      status: 429,
      ...(typeof retry === "number" ? { retryAfterSec: retry } : {}),
      ...withDescription,
    };
  }
  if (response.status >= 500)
    return { ok: false, kind: "server", status: response.status, ...withDescription };
  return { ok: false, kind: "rejected", status: response.status, ...withDescription };
}
