import type {
  MonitorRow,
  MonitorStore,
  NewFinding,
  OpenFinding,
  WatchState,
} from "../../../_shared/adapters/monitor_store.ts";
import type { LatestLike, SeenItems } from "../../../_shared/core/risk.ts";

export interface FakeFinding extends NewFinding {
  id: string;
  resolved: boolean;
}

export class FakeMonitor implements MonitorStore {
  monitorRows: MonitorRow[] = [];
  findings: FakeFinding[] = [];
  touched: { securityId: string; lastCheckAt: string; nextDueAt: string; seen?: SeenItems }[] = [];
  previous: { category: string | null; summary: string | null; date: string | null } | null = null;
  private seq = 0;

  addRow(over: Partial<MonitorRow> & { userId: string; securityId: string }): MonitorRow {
    const row: MonitorRow = {
      lastReportId: null,
      lastCategory: null,
      seen: {},
      latest: {},
      lastCheckAt: null,
      nextDueAt: null,
      ...over,
    };
    this.monitorRows.push(row);
    return row;
  }
  async rows(securityId: string) {
    return structuredClone(this.monitorRows.filter((r) => r.securityId === securityId));
  }
  async listDue(nowIso: string) {
    return [
      ...new Set(
        this.monitorRows
          .filter((r) => r.nextDueAt === null || r.nextDueAt <= nowIso)
          .map((r) => r.securityId),
      ),
    ];
  }
  async touch(
    securityId: string,
    patch: { lastCheckAt: string; nextDueAt: string; seen?: SeenItems },
  ) {
    this.touched.push({ securityId, ...patch });
    for (const r of this.monitorRows.filter((x) => x.securityId === securityId)) {
      r.lastCheckAt = patch.lastCheckAt;
      r.nextDueAt = patch.nextDueAt;
      if (patch.seen) r.seen = patch.seen;
    }
  }
  async openFinding(
    userId: string,
    securityId: string,
    category: string,
  ): Promise<OpenFinding | null> {
    const f = this.findings.find(
      (x) =>
        x.userId === userId &&
        x.securityId === securityId &&
        x.category === category &&
        !x.resolved,
    );
    return f
      ? {
          id: f.id,
          category: f.category,
          fingerprint: f.fingerprint,
          primaryUrls: f.evidence.filter((e) => e.primary).map((e) => e.url),
        }
      : null;
  }
  async insertFinding(f: NewFinding) {
    if (
      this.findings.some(
        (x) =>
          x.userId === f.userId && x.securityId === f.securityId && x.fingerprint === f.fingerprint,
      )
    )
      return false;
    this.findings.push({ ...f, id: `f-${++this.seq}`, resolved: false });
    return true;
  }
  async updateFinding(
    id: string,
    patch: { summary: string; severity: string; evidence: NewFinding["evidence"] },
  ) {
    const f = this.findings.find((x) => x.id === id);
    if (f)
      Object.assign(f, {
        summary: patch.summary,
        severity: patch.severity as FakeFinding["severity"],
        evidence: patch.evidence,
      });
  }
  async previousAssessment() {
    return this.previous;
  }
  watches = new Map<string, WatchState>();
  watchTouched: { reportId: string; lastCheckAt: string; nextDueAt: string; seen?: SeenItems }[] =
    [];
  async watch(securityId: string) {
    const w = this.watches.get(securityId);
    return w ? structuredClone(w) : null;
  }
  async touchWatch(
    reportId: string,
    patch: { lastCheckAt: string; nextDueAt: string; seen?: SeenItems },
  ) {
    this.watchTouched.push({ reportId, ...patch });
    for (const w of this.watches.values()) {
      if (w.reportId !== reportId) continue;
      w.lastCheckAt = patch.lastCheckAt;
      w.nextDueAt = patch.nextDueAt;
      if (patch.seen) w.seen = patch.seen;
    }
  }
  setLatest(securityId: string, latest: LatestLike) {
    for (const r of this.monitorRows.filter((x) => x.securityId === securityId)) r.latest = latest;
  }
}
