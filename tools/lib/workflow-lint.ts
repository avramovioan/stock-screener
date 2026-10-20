// owner/repo[/path]@vN | vN.N | vN.N.N | 40-hex commit SHA
const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@(v\d+(\.\d+){0,2}|[0-9a-f]{40})$/;

type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural lint of one parsed workflow; returns problems (empty = fine). */
export function lintWorkflow(doc: unknown, file: string): string[] {
  const problems: string[] = [];
  const add = (message: string) => problems.push(`${file}: ${message}`);
  if (!isMapping(doc)) {
    add("not a YAML mapping");
    return problems;
  }

  if (typeof doc.name !== "string" || doc.name === "") add("missing name");

  const triggers = doc.on;
  if (triggers === undefined || triggers === null) {
    add("missing on:");
  } else if (
    triggers === "pull_request_target" ||
    (isMapping(triggers) && "pull_request_target" in triggers)
  ) {
    add("pull_request_target is not allowed (it runs untrusted code with secrets)");
  }

  const jobs = doc.jobs;
  if (!isMapping(jobs) || Object.keys(jobs).length === 0) {
    add("no jobs");
    return problems;
  }

  if (JSON.stringify(jobs).includes("pull_request.labels")) {
    const pr = isMapping(triggers) ? triggers.pull_request : undefined;
    const types = isMapping(pr) && Array.isArray(pr.types) ? pr.types : [];
    if (!types.includes("labeled")) {
      add("a job reads pull_request.labels but on.pull_request.types does not include labeled");
    }
  }

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isMapping(job)) {
      add(`job ${jobId}: not a mapping`);
      continue;
    }
    if (!("runs-on" in job)) add(`job ${jobId}: missing runs-on`);
    if (doc.permissions === undefined && job.permissions === undefined) {
      add(`job ${jobId}: no permissions (declare least privilege at workflow or job level)`);
    }
    const steps = job.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      add(`job ${jobId}: no steps`);
      continue;
    }
    steps.forEach((step, index) => {
      const label = `job ${jobId} step ${index + 1}`;
      if (!isMapping(step) || (typeof step.uses !== "string" && typeof step.run !== "string")) {
        add(`${label}: needs uses or run`);
        return;
      }
      const uses = step.uses;
      if (typeof uses === "string" && !uses.startsWith("./") && !PINNED_ACTION.test(uses)) {
        add(`${label}: action ${uses} must be pinned to a version tag or commit SHA`);
      }
    });
  }
  return problems;
}
