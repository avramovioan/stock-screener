const FORBIDDEN = [
  /(^|\/)\.env(\.|$)(?!example$)/,
  /^supabase\/\.temp\//,
  /^apps\/web\/dist\//,
  /^backups\//,
  /(^|\/)\.wrangler\//,
  /(^|\/)playwright-report\//,
  /(^|\/)test-results\//,
];

export function trackedForbiddenFiles(files: string[]): string[] {
  return files.filter((f) => !f.endsWith(".env.example") && FORBIDDEN.some((re) => re.test(f)));
}

export function unresolvedMarkers(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line, i) =>
      /\b(TODO|TBD|FIXME)\b|<fill/i.test(line) ? `line ${i + 1}: ${line.trim()}` : null,
    )
    .filter((l): l is string => l !== null);
}

export interface EvidenceSummary {
  results: Array<{ name: string; exitCode: number | null; skipped?: string }>;
}

export function evidenceProblems(summary: EvidenceSummary, required: string[]): string[] {
  const problems: string[] = [];
  for (const name of required) {
    const r = summary.results.find((x) => x.name === name);
    if (r === undefined) problems.push(`suite ${name} has no evidence`);
    else if (r.skipped !== undefined) problems.push(`suite ${name} was skipped (${r.skipped})`);
    else if (r.exitCode !== 0) problems.push(`suite ${name} did not pass (exit ${r.exitCode})`);
  }
  return problems;
}

export interface GitState {
  branch: string;
  porcelain: string;
  /** commits on master that build/initial lacks */
  behind: number;
  /** commits on build/initial that master lacks */
  ahead: number;
  tagExists: boolean;
}

export function gitProblems(s: GitState): string[] {
  const problems: string[] = [];
  if (s.branch !== "build/initial")
    problems.push(`HEAD is ${s.branch}; release from build/initial`);
  if (s.porcelain.trim() !== "")
    problems.push("the working tree is not clean (commit or discard first)");
  if (s.behind > 0)
    problems.push(
      `master has ${s.behind} commit(s) that build/initial lacks: a fast-forward is impossible (rebase or merge master into build/initial first)`,
    );
  if (s.ahead === 0) problems.push("build/initial has no commits beyond master: nothing to merge");
  if (s.tagExists) problems.push("the tag v0.1.0-local already exists");
  return problems;
}
