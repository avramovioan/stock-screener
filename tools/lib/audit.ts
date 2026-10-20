export type Severity = "info" | "low" | "moderate" | "high" | "critical";
export interface Advisory {
  pkg: string;
  severity: Severity;
  id: string;
  title: string;
}
export interface AuditException {
  id: string;
  reason: string;
  expires: string;
}

const SEVERITIES = new Set<string>(["info", "low", "moderate", "high", "critical"]);
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const severityOf = (v: unknown): Severity =>
  typeof v === "string" && SEVERITIES.has(v) ? (v as Severity) : "low";

function advisoryId(url: unknown, id: unknown): string {
  if (typeof url === "string") {
    const ghsa = /GHSA-[a-z0-9-]+/i.exec(url)?.[0];
    if (ghsa !== undefined) return ghsa;
    return url;
  }
  return String(id ?? "unknown");
}

/** `bun audit --json`: { "<package>": [ { id, url, title, severity, vulnerable_versions } ] }. */
export function parseBunAudit(json: unknown): Advisory[] {
  if (!isRec(json)) return [];
  const out: Advisory[] = [];
  for (const [pkg, list] of Object.entries(json)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRec(item)) continue;
      out.push({
        pkg,
        severity: severityOf(item.severity),
        id: advisoryId(item.url, item.id),
        title: String(item.title ?? ""),
      });
    }
  }
  return out;
}

/** `npm audit --json` (npm 7+): { vulnerabilities: { <package>: { via: [ { source, title, url, severity } | "<package>" ] } } }. */
export function parseNpmAudit(json: unknown): Advisory[] {
  if (!isRec(json) || !isRec(json.vulnerabilities)) return [];
  const out: Advisory[] = [];
  for (const [pkg, vuln] of Object.entries(json.vulnerabilities)) {
    if (!isRec(vuln) || !Array.isArray(vuln.via)) continue;
    for (const via of vuln.via) {
      if (!isRec(via)) continue;
      out.push({
        pkg,
        severity: severityOf(via.severity),
        id: advisoryId(via.url, via.source),
        title: String(via.title ?? ""),
      });
    }
  }
  return out;
}

export function auditProblems(
  advisories: Advisory[],
  exceptions: AuditException[],
  nowMs: number,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();
  for (const a of advisories) {
    if (a.severity !== "high" && a.severity !== "critical") continue;
    const exception = exceptions.find((e) => e.id === a.id);
    if (exception === undefined) {
      problems.push(
        `${a.severity} advisory ${a.id} in ${a.pkg}: ${a.title} (fix the dependency or add a reviewed exception)`,
      );
      continue;
    }
    used.add(exception.id);
    if (Date.parse(`${exception.expires}T23:59:59Z`) < nowMs) {
      problems.push(
        `exception for ${a.id} (${a.pkg}) expired on ${exception.expires}: ${exception.reason}`,
      );
    }
  }
  for (const e of exceptions)
    if (!used.has(e.id)) warnings.push(`exception ${e.id} matches no current advisory (remove it)`);
  return { problems, warnings };
}

const NPM_SPECIFIER =
  /npm:((?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*)@(\d+\.\d+\.\d+[\w.+-]*)/g;

export function specifiersFromSource(text: string): Array<{ name: string; version: string }> {
  return [...text.matchAll(NPM_SPECIFIER)].map((m) => ({
    name: m[1] as string,
    version: m[2] as string,
  }));
}
