import type { UniverseMode } from "./thresholds.ts";

export interface RankCandidate {
  securityId: string;
  companyId: string;
  yahooSymbol: string;
  marketCapUsd: number;
  isUsPrimary: boolean;
}

export interface RankedRow extends RankCandidate {
  mode: UniverseMode;
  rank: number;
  isTop10: boolean;
}

/** One digest entry per company: the first mode of modeOrder with a row is primary, the others are listed in alsoIn (D12). */
export interface MergedEntry {
  companyId: string;
  primary: RankedRow;
  alsoIn: UniverseMode[];
}

const US_EXCHANGES: ReadonlySet<string> = new Set(["NMS", "NYQ", "NGM"]);

export function isUsExchange(code: string): boolean {
  return US_EXCHANGES.has(code);
}

/** UTF-16 code-unit comparison (never localeCompare). */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort descending by marketCapUsd, tie-break ascending yahooSymbol (code-unit order). Ranks 1..N are unique.
 * "us" ranks only isUsPrimary members. Changing the tie-break is a breaking change.
 */
export function rankUniverse(members: RankCandidate[], mode: UniverseMode): RankedRow[] {
  const pool = mode === "us" ? members.filter((m) => m.isUsPrimary) : [...members];
  pool.sort(
    (a, b) => b.marketCapUsd - a.marketCapUsd || compareCodeUnits(a.yahooSymbol, b.yahooSymbol),
  );
  return pool.map((m, i) => ({ ...m, mode, rank: i + 1, isTop10: i + 1 <= 10 }));
}

/**
 * US-primary (A-05): US exchange AND financialCurrency USD AND no higher-volume home listing AND home country the United States
 * (when known). An override from security_identity_overrides wins.
 */
export function isUsPrimary(input: {
  canonicalExchange: string;
  financialCurrency: string | null;
  homeCountry: string | null;
  hasHigherVolumeHomeListing: boolean;
  override: "force_us" | "force_not_us" | null;
}): boolean {
  if (input.override === "force_us") return true;
  if (input.override === "force_not_us") return false;
  return (
    isUsExchange(input.canonicalExchange) &&
    input.financialCurrency === "USD" &&
    !input.hasHigherVolumeHomeListing &&
    (input.homeCountry === null || input.homeCountry === "United States")
  );
}

export function mergeModesForNotification(
  rows: RankedRow[],
  modeOrder: UniverseMode[] = ["worldwide", "us"],
): MergedEntry[] {
  const byCompany = new Map<string, RankedRow[]>();
  for (const r of rows) {
    const list = byCompany.get(r.companyId);
    if (list === undefined) byCompany.set(r.companyId, [r]);
    else list.push(r);
  }
  const out: MergedEntry[] = [];
  for (const [companyId, list] of byCompany) {
    const ordered = [...list].sort((a, b) => modeOrder.indexOf(a.mode) - modeOrder.indexOf(b.mode));
    const primary = ordered[0] as RankedRow;
    out.push({ companyId, primary, alsoIn: ordered.slice(1).map((r) => r.mode) });
  }
  out.sort(
    (a, b) =>
      a.primary.rank - b.primary.rank ||
      compareCodeUnits(a.primary.yahooSymbol, b.primary.yahooSymbol),
  );
  return out;
}
