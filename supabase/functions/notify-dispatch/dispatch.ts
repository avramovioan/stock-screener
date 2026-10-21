import type { PushResult, PushTarget, SendPushOptions } from "@adapters/push.ts";
import type { TelegramResult } from "@adapters/telegram.ts";
import {
  type DigestKind,
  type DiscountEntry,
  digestTopic,
  type PortfolioEntryView,
  pushPayload,
} from "@core/digest.ts";
import { telegramDigestMessage } from "@core/telegram-message.ts";

export const RETRY_SECONDS = [60, 300, 1800, 7200] as const;
export const MAX_ATTEMPTS = 5;
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const PUSH_TTL_SECONDS = 21_600;

export interface ClaimedDelivery {
  id: string;
  digestId: string;
  /** the user of a user digest delivery; null for a device delivery (the public digest) */
  userId: string | null;
  /** the anonymous device of a device delivery; null for a user delivery */
  subscriptionId: string | null;
  channel: "push" | "email";
  attempts: number;
  idempotencyKey: string;
  quotaConsumed: boolean;
  kind: DigestKind;
  content: unknown;
  scanRunId: string;
  digestCreatedAt: string;
  scanDate: string;
  prefs: { pushEnabled: boolean };
}

export interface Completion {
  status: "sent" | "failed" | "skipped" | "pending";
  skipReason?: string | null;
  error?: string | null;
  messageId?: string | null;
  retryInSeconds?: number | null;
  log: Record<string, unknown>;
}

/** One Telegram message of a public digest (table telegram_deliveries). */
export interface ClaimedTelegram {
  id: string;
  digestId: string;
  attempts: number;
  content: unknown;
  digestCreatedAt: string;
  scanDate: string;
}

export interface TelegramCompletion {
  status: "sent" | "failed" | "skipped" | "pending";
  /** a short, value-free code: never a token, a URL or a chat id */
  error?: string | null;
  messageId?: number | null;
  retryInSeconds?: number | null;
}

export interface DispatchStore {
  claim(limit: number): Promise<ClaimedDelivery[]>;
  claimTelegram(limit: number): Promise<ClaimedTelegram[]>;
  completeTelegram(id: string, completion: TelegramCompletion): Promise<void>;
  /** the user's active devices that have the topic of this digest kind on */
  subscriptions(userId: string, kind: DigestKind): Promise<(PushTarget & { id: string })[]>;
  /** the device behind a public delivery when it is still active, anonymous and opted in to discounts */
  deviceSubscription(subscriptionId: string): Promise<(PushTarget & { id: string }) | null>;
  markSubscription(id: string, outcome: "success" | "failure" | "gone"): Promise<void>;
  complete(id: string, completion: Completion): Promise<void>;
}

export interface DispatchDeps {
  store: DispatchStore;
  sendPush(sub: PushTarget, payloadJson: string, opts: SendPushOptions): Promise<PushResult>;
  /** null when TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set: the feature is off, nothing is claimed */
  telegram: { send(text: string): Promise<TelegramResult> } | null;
  nowMs(): number;
  siteUrl: string;
  log(event: string, data: Record<string, unknown>): void;
}

function items(d: ClaimedDelivery): unknown[] {
  const raw = (d.content as { items?: unknown } | null)?.items;
  return Array.isArray(raw) ? raw : [];
}

function skip(d: ClaimedDelivery, reason: string): Completion {
  return {
    status: "skipped",
    skipReason: reason,
    log: { attempt: d.attempts, status: "skipped", detail: reason },
  };
}

function backoffSeconds(attempts: number): number {
  return (
    RETRY_SECONDS[Math.min(attempts, RETRY_SECONDS.length) - 1] ??
    RETRY_SECONDS[RETRY_SECONDS.length - 1] ??
    60
  );
}

function retryOrFail(d: ClaimedDelivery, error: string, minDelaySec = 0): Completion {
  if (d.attempts >= MAX_ATTEMPTS) {
    return {
      status: "failed",
      error: `attempts_exhausted:${error}`,
      log: { attempt: d.attempts, status: "failed", detail: error },
    };
  }
  const base = backoffSeconds(d.attempts);
  return {
    status: "pending",
    error,
    retryInSeconds: Math.max(base, minDelaySec),
    log: { attempt: d.attempts, status: "retry", detail: error },
  };
}

async function processPush(d: ClaimedDelivery, deps: DispatchDeps): Promise<Completion> {
  let subs: (PushTarget & { id: string })[];
  if (d.subscriptionId !== null) {
    const device = await deps.store.deviceSubscription(d.subscriptionId);
    subs = device === null ? [] : [device];
  } else {
    if (!d.prefs.pushEnabled || d.userId === null) return skip(d, "preference_off");
    subs = await deps.store.subscriptions(d.userId, d.kind);
  }
  if (subs.length === 0) return skip(d, "no_subscription");
  const payload = JSON.stringify(
    d.kind === "discounts"
      ? pushPayload("discounts", items(d) as DiscountEntry[], deps.siteUrl)
      : pushPayload("portfolio", items(d) as PortfolioEntryView[], deps.siteUrl),
  );
  const opts: SendPushOptions = {
    ttlSeconds: PUSH_TTL_SECONDS,
    topic: digestTopic(d.kind),
    urgency: "normal",
  };
  let sentAny = false;
  let gone = 0;
  let retry = null as { error: string; after: number } | null;
  for (const sub of subs) {
    const result = await deps.sendPush(
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      payload,
      opts,
    );
    if (result.ok) {
      sentAny = true;
      await deps.store.markSubscription(sub.id, "success");
    } else if (result.kind === "gone") {
      gone++;
      await deps.store.markSubscription(sub.id, "gone");
    } else if (result.kind === "rate_limited") {
      retry = {
        error: "push_rate_limited",
        after: Math.max(retry?.after ?? 0, result.retryAfterSec ?? 0),
      };
    } else if (
      result.kind === "network" ||
      (result.kind === "http" && (result.status ?? 0) >= 500)
    ) {
      retry = {
        error: result.kind === "network" ? "push_network" : `push_http_${result.status}`,
        after: retry?.after ?? 0,
      };
    } else if (result.kind === "payload_too_large") {
      // our payload, not the subscription's fault: never count it against the subscription
    } else {
      await deps.store.markSubscription(sub.id, "failure");
    }
  }
  if (sentAny)
    return {
      status: "sent",
      log: { attempt: d.attempts, status: "sent", detail: `${subs.length - gone} subscriptions` },
    };
  if (retry !== null) return retryOrFail(d, retry.error, retry.after);
  if (gone === subs.length) return skip(d, "no_subscription");
  return {
    status: "failed",
    error: "push_rejected",
    log: { attempt: d.attempts, status: "failed", detail: "push_rejected" },
  };
}

/** Decides the fate of one claimed delivery and records it on the SAME delivery row. */
export async function processDelivery(d: ClaimedDelivery, deps: DispatchDeps): Promise<Completion> {
  if (deps.nowMs() - Date.parse(d.digestCreatedAt) > EXPIRY_MS) {
    return {
      status: "failed",
      error: "expired",
      log: { attempt: d.attempts, status: "failed", detail: "expired" },
    };
  }
  // The e-mail channel is gone; a row left over from before is closed, never sent.
  if (d.channel !== "push") return skip(d, "channel_removed");
  return await processPush(d, deps);
}

/** Decides the fate of one claimed Telegram delivery: one message per public digest, retried like push, expired after 24 hours. */
export async function processTelegram(
  d: ClaimedTelegram,
  deps: DispatchDeps,
): Promise<TelegramCompletion> {
  if (deps.nowMs() - Date.parse(d.digestCreatedAt) > EXPIRY_MS)
    return { status: "failed", error: "expired" };
  const raw = (d.content as { items?: unknown } | null)?.items;
  const list = Array.isArray(raw) ? (raw as DiscountEntry[]) : [];
  if (list.length === 0) return { status: "skipped", error: "empty" };
  if (deps.telegram === null) return { status: "skipped", error: "not_configured" };
  const result = await deps.telegram.send(telegramDigestMessage(list, d.scanDate, deps.siteUrl));
  if (result.ok) return { status: "sent", messageId: result.messageId };
  if (result.kind === "rejected")
    return { status: "failed", error: `telegram_${result.status ?? "rejected"}` };
  const error =
    result.kind === "network" ? "telegram_network" : `telegram_${result.status ?? "http"}`;
  if (d.attempts >= MAX_ATTEMPTS) return { status: "failed", error: `attempts_exhausted:${error}` };
  return {
    status: "pending",
    error,
    retryInSeconds: Math.max(backoffSeconds(d.attempts), result.retryAfterSec ?? 0),
  };
}

export interface DispatchResult {
  claimed: number;
  processed: number;
  errors: number;
}

export async function runDispatch(
  deps: DispatchDeps,
  opts: { limit: number; budgetMs: number },
): Promise<DispatchResult> {
  const deadline = deps.nowMs() + opts.budgetMs;
  const result: DispatchResult = { claimed: 0, processed: 0, errors: 0 };
  while (deps.nowMs() < deadline) {
    const batch = await deps.store.claim(opts.limit);
    if (batch.length === 0) break;
    result.claimed += batch.length;
    for (const d of batch) {
      if (deps.nowMs() >= deadline) return result; // unprocessed rows return when their 10 minute lease ends
      try {
        const completion = await processDelivery(d, deps);
        await deps.store.complete(d.id, completion);
        result.processed++;
        deps.log("delivery_processed", {
          delivery: d.id,
          channel: d.channel,
          status: completion.status,
          attempt: d.attempts,
        });
      } catch (error) {
        result.errors++;
        deps.log("delivery_error", {
          delivery: d.id,
          channel: d.channel,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  }
  await runTelegram(deps, opts, deadline, result);
  return result;
}

/** The Telegram group's messages, in the same run as push; skipped entirely while the feature is off. */
async function runTelegram(
  deps: DispatchDeps,
  opts: { limit: number },
  deadline: number,
  result: DispatchResult,
): Promise<void> {
  if (deps.telegram === null) return;
  while (deps.nowMs() < deadline) {
    const batch = await deps.store.claimTelegram(opts.limit);
    if (batch.length === 0) return;
    result.claimed += batch.length;
    for (const d of batch) {
      if (deps.nowMs() >= deadline) return;
      try {
        const completion = await processTelegram(d, deps);
        await deps.store.completeTelegram(d.id, completion);
        result.processed++;
        deps.log("telegram_processed", {
          delivery: d.id,
          status: completion.status,
          attempt: d.attempts,
          ...(completion.error ? { error: completion.error } : {}),
        });
      } catch (error) {
        result.errors++;
        deps.log("telegram_error", {
          delivery: d.id,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  }
}
