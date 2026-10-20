import {
  buildDiscountDigest,
  buildPortfolioDigest,
  canonicalJson,
  type DigestKind,
  type DiscountEntry,
  type PortfolioEntryView,
} from "@core/digest.ts";
import type { UniverseMode } from "@core/thresholds.ts";
import { displayTicker } from "@core/ticker.ts";

export type DigestReason = "complete" | "cutoff";

export interface DigestUser {
  userId: string;
  pushEnabled: boolean;
  /** an active device of any kind */
  hasActivePush: boolean;
  /** an active device with the discounts topic on */
  hasDiscountsPush: boolean;
  /** an active device with the portfolio topic on */
  hasPortfolioPush: boolean;
  modes: UniverseMode[];
  sendEmpty: boolean;
  holdsPositions: boolean;
}

export interface DiscountRow {
  episodeId: string;
  companyId: string;
  securityId: string;
  mode: UniverseMode;
  rank: number;
  yahooSymbol: string;
  exchangeCode: string;
  name: string;
  close: number;
  currency: string;
  sessionDate: string;
  thresholdLine: string;
  /** Worldwide rank 1-10 at the scan: the entry is a "Strong buy". */
  isTop10: boolean;
  /** close <= the -4 line: rank 11+ entries say "Reached its -4 line", otherwise "Wait for the -4 line". */
  reachedLine4: boolean;
  /** Outcome of a complete report; null when the company is not researched yet. */
  category: string | null;
  conclusion: string | null;
  bankruptcyRisk: string | null;
  summary: string;
  eurSymbol: string | null;
  eurStatus: string | null;
}

export interface PremiumRow {
  episodeId: string;
  securityId: string;
  yahooSymbol: string;
  name: string;
  kind: "premium1" | "premium2";
  close: number;
  ccy: string;
  sessionDate: string;
  researchStatus: string;
}

export interface RiskRow {
  id: string;
  securityId: string;
  yahooSymbol: string;
  name: string;
  category: string;
  summary: string;
  detectedOn: string;
  researchStatus: string;
}

export interface PortfolioCandidates {
  premium: PremiumRow[];
  risks: RiskRow[];
}

export interface ScanRunInfo {
  id: string;
  status: string;
  scanDateLocal: string;
  digestsCreatedAt: string | null;
}

export interface DigestItemInput {
  ref_type: "episode" | "finding";
  ref_id: string;
  payload: Record<string, unknown>;
}
export interface ChannelInput {
  channel: "push";
  status: "pending" | "skipped";
  skip_reason: string | null;
}
export interface InsertDigestArgs {
  scanRunId: string;
  userId: string;
  kind: DigestKind;
  content: { kind: DigestKind; scanDate: string; items: unknown[] } & Record<string, unknown>;
  hash: string;
  reason: DigestReason;
  status: "ready" | "skipped";
  skipReason: string | null;
  items: DigestItemInput[];
  channels: ChannelInput[];
  scanDate: string;
}

export interface InsertPublicDigestArgs {
  scanRunId: string;
  content: { kind: "discounts"; scanDate: string; items: unknown[] } & Record<string, unknown>;
  hash: string;
  reason: DigestReason;
  status: "ready" | "skipped";
  skipReason: string | null;
  scanDate: string;
}

export interface DigestStore {
  scanRun(id: string): Promise<ScanRunInfo | null>;
  getUsers(): Promise<DigestUser[]>;
  discountCandidates(
    scanRunId: string,
    userId: string,
    finishedOnly: boolean,
  ): Promise<DiscountRow[]>;
  portfolioCandidates(scanRunId: string, userId: string): Promise<PortfolioCandidates>;
  /** the run's new-on-the-list companies for anonymous devices: no user, no country filter, no per-user dedupe */
  publicDiscountCandidates(scanRunId: string): Promise<DiscountRow[]>;
  /** one transaction; returns null when the run's public digest already exists. A ready digest gets one delivery per active anonymous device with the discounts topic. */
  insertPublicDigest(args: InsertPublicDigestArgs): Promise<string | null>;
  /** one transaction; returns null when the (scan, kind, user) digest already exists */
  insertDigest(args: InsertDigestArgs): Promise<string | null>;
  finish(scanRunId: string, reason: DigestReason, stats: Record<string, unknown>): Promise<boolean>;
}

export interface DigestStageDeps {
  store: DigestStore;
  sha256Hex(text: string): Promise<string>;
  log(event: string, data: Record<string, unknown>): void;
}

export interface DigestStageResult {
  status: "created" | "skipped_already_created" | "skipped_failed_scan";
  users: number;
  created: number;
  existing: number;
  skippedEmpty: number;
  /** the public (anonymous devices) digest of the run */
  publicDigest: "created" | "existing" | "skipped_empty" | "none";
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toDiscountEntry(r: DiscountRow): DiscountEntry {
  const eurStatus = r.eurStatus;
  const eur: DiscountEntry["eur"] =
    r.eurSymbol !== null &&
    (eurStatus === "verified" || eurStatus === "unverified" || eurStatus === "none")
      ? { symbol: r.eurSymbol, status: eurStatus }
      : null;
  return {
    episodeId: r.episodeId,
    companyId: r.companyId,
    securityId: r.securityId,
    mode: r.mode,
    alsoIn: [],
    rank: r.rank,
    yahooSymbol: r.yahooSymbol,
    ticker: displayTicker(r.yahooSymbol, r.exchangeCode),
    name: r.name,
    close: r.close,
    ccy: r.currency,
    sessionDate: r.sessionDate,
    line: r.thresholdLine === "-4" ? "-4" : "-3",
    isTop10: r.isTop10,
    reachedLine4: r.reachedLine4,
    category:
      r.category === "green" ||
      r.category === "amber" ||
      r.category === "red" ||
      r.category === "grey"
        ? r.category
        : null,
    conclusion: r.conclusion ?? "",
    bankruptcyRisk: r.bankruptcyRisk ?? "Unclear",
    summary: r.summary,
    eur,
  };
}

function channelsFor(u: DigestUser, kind: DigestKind): ChannelInput[] {
  const push: ChannelInput = !u.pushEnabled
    ? { channel: "push", status: "skipped", skip_reason: "preference_off" }
    : !(kind === "discounts" ? u.hasDiscountsPush : u.hasPortfolioPush)
      ? { channel: "push", status: "skipped", skip_reason: "no_subscription" }
      : { channel: "push", status: "pending", skip_reason: null };
  return [push];
}

export async function runDigestStage(
  scanRunId: string,
  reason: DigestReason,
  deps: DigestStageDeps,
): Promise<DigestStageResult> {
  const { store } = deps;
  const run = await store.scanRun(scanRunId);
  const empty = {
    users: 0,
    created: 0,
    existing: 0,
    skippedEmpty: 0,
    publicDigest: "none" as const,
  };
  if (run === null || run.status === "failed") return { status: "skipped_failed_scan", ...empty };
  if (run.digestsCreatedAt !== null) return { status: "skipped_already_created", ...empty };

  const users = await store.getUsers();
  let created = 0;
  let existing = 0;
  let skippedEmpty = 0;
  let failed = 0;
  let publicFailed = false;

  const write = async (args: InsertDigestArgs) => {
    const id = await store.insertDigest(args);
    if (id === null) existing++;
    else if (args.status === "skipped") skippedEmpty++;
    else created++;
  };

  for (const user of users) {
    try {
      // --- Today's Discounts ------------------------------------------------------------------
      // Candidates are the companies new on the list; research state is irrelevant, so nothing waits (spec 5.12).
      const cleared = await store.discountCandidates(scanRunId, user.userId, false);
      const built = buildDiscountDigest(cleared.map(toDiscountEntry), {
        modes: user.modes,
        sendEmpty: user.sendEmpty,
      });
      const kept = new Set(built.items.map((i) => i.companyId));
      const primaryByCompany = new Map(built.items.map((i) => [i.companyId, i.episodeId]));
      const mergedAway = cleared.filter(
        (r) =>
          user.modes.includes(r.mode) &&
          kept.has(r.companyId) &&
          !built.items.some((i) => i.episodeId === r.episodeId),
      );
      const discountContent = {
        kind: "discounts" as const,
        scanDate: run.scanDateLocal,
        items: built.items,
      };
      await write({
        scanRunId,
        userId: user.userId,
        kind: "discounts",
        content: discountContent,
        hash: await deps.sha256Hex(canonicalJson(discountContent)),
        reason,
        status: built.skipReason === null ? "ready" : "skipped",
        skipReason: built.skipReason,
        items: [
          ...built.items.map((i) => ({
            ref_type: "episode" as const,
            ref_id: i.episodeId,
            payload: {},
          })),
          ...mergedAway.map((r) => ({
            ref_type: "episode" as const,
            ref_id: r.episodeId,
            payload: { mergedInto: primaryByCompany.get(r.companyId) ?? null },
          })),
        ],
        channels: built.skipReason === null ? channelsFor(user, "discounts") : [],
        scanDate: run.scanDateLocal,
      });

      // --- Portfolio Alerts (holders only; broker_positions may be empty) ---------------------------
      if (user.holdsPositions) {
        const cand = await store.portfolioCandidates(scanRunId, user.userId);
        const entries: PortfolioEntryView[] = [
          ...cand.premium.map((p) => ({
            key: p.securityId,
            securityId: p.securityId,
            yahooSymbol: p.yahooSymbol,
            name: p.name,
            priceSignals: [p.kind],
            riskFindingIds: [],
            researchStatus: p.researchStatus,
            signals: [{ kind: p.kind, close: p.close, ccy: p.ccy, sessionDate: p.sessionDate }],
            risks: [],
          })),
          ...cand.risks.map((r) => ({
            key: r.securityId,
            securityId: r.securityId,
            yahooSymbol: r.yahooSymbol,
            name: r.name,
            priceSignals: [],
            riskFindingIds: [r.id],
            researchStatus: r.researchStatus,
            signals: [],
            risks: [
              { id: r.id, category: r.category, summary: r.summary, detectedOn: r.detectedOn },
            ],
          })),
        ];
        const portfolio = buildPortfolioDigest(entries, user.sendEmpty);
        const content = {
          kind: "portfolio" as const,
          scanDate: run.scanDateLocal,
          items: portfolio.items,
        };
        await write({
          scanRunId,
          userId: user.userId,
          kind: "portfolio",
          content,
          hash: await deps.sha256Hex(canonicalJson(content)),
          reason,
          status: portfolio.skipReason === null ? "ready" : "skipped",
          skipReason: portfolio.skipReason,
          items: [
            ...cand.premium.map((p) => ({
              ref_type: "episode" as const,
              ref_id: p.episodeId,
              payload: {},
            })),
            ...cand.risks.map((r) => ({
              ref_type: "finding" as const,
              ref_id: r.id,
              payload: {},
            })),
          ],
          channels: portfolio.skipReason === null ? channelsFor(user, "portfolio") : [],
          scanDate: run.scanDateLocal,
        });
      }
    } catch (error) {
      failed++;
      deps.log("digest_user_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  // --- The public digest: the same "new on the list" rule for anonymous devices, once per run ---------------------
  let publicDigest: DigestStageResult["publicDigest"] = "none";
  try {
    const candidates = await store.publicDiscountCandidates(scanRunId);
    const built = buildDiscountDigest(candidates.map(toDiscountEntry), {
      modes: ["worldwide"],
      sendEmpty: false,
    });
    const content = { kind: "discounts" as const, scanDate: run.scanDateLocal, items: built.items };
    const id = await store.insertPublicDigest({
      scanRunId,
      content,
      hash: await deps.sha256Hex(canonicalJson(content)),
      reason,
      status: built.skipReason === null ? "ready" : "skipped",
      skipReason: built.skipReason,
      scanDate: run.scanDateLocal,
    });
    publicDigest =
      id === null ? "existing" : built.skipReason === null ? "created" : "skipped_empty";
  } catch (error) {
    failed++;
    publicFailed = true;
    deps.log("digest_public_failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
  }

  if (failed > 0)
    throw new Error(
      publicFailed
        ? `digest stage: the public digest and ${failed - 1} of ${users.length} users failed; the job will be retried`
        : `digest stage: ${failed} of ${users.length} users failed; the job will be retried`,
    );
  const stats = { users: users.length, created, existing, skippedEmpty, publicDigest };
  await store.finish(scanRunId, reason, stats);
  return { status: "created", ...stats };
}
