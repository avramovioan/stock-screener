import { describe, expect, it } from "vitest";
import { lintWorkflow } from "./workflow-lint.ts";

const good = () => ({
  name: "CI",
  on: { push: { branches: ["master"] }, pull_request: null },
  permissions: { contents: "read" },
  jobs: {
    web: {
      "runs-on": "ubuntu-latest",
      steps: [{ uses: "actions/checkout@v4" }, { run: "bun run lint" }],
    },
  },
});

describe("lintWorkflow", () => {
  it("accepts a well-formed workflow", () => {
    expect(lintWorkflow(good(), "ci.yml")).toEqual([]);
  });

  it("accepts actions pinned to a major tag, a full tag or a commit SHA, and local actions", () => {
    const workflow = good();
    workflow.jobs.web.steps = [
      { uses: "oven-sh/setup-bun@v2" },
      { uses: "owner/repo@v1.2.3" },
      { uses: `owner/repo@${"a".repeat(40)}` },
      { uses: "./.github/actions/local" },
    ];
    expect(lintWorkflow(workflow, "ci.yml")).toEqual([]);
  });

  it("flags unpinned actions", () => {
    const workflow = good();
    workflow.jobs.web.steps = [{ uses: "actions/checkout@main" }, { uses: "actions/setup-node" }];
    expect(lintWorkflow(workflow, "ci.yml")).toHaveLength(2);
  });

  it("flags a missing name, trigger or jobs", () => {
    expect(lintWorkflow({ jobs: {} }, "x.yml")).toEqual([
      "x.yml: missing name",
      "x.yml: missing on:",
      "x.yml: no jobs",
    ]);
  });

  it("flags jobs without runs-on or steps", () => {
    const workflow = {
      ...good(),
      jobs: { a: { steps: [{ run: "x" }] }, b: { "runs-on": "ubuntu-latest" } },
    };
    const problems = lintWorkflow(workflow, "ci.yml");
    expect(problems).toContain("ci.yml: job a: missing runs-on");
    expect(problems).toContain("ci.yml: job b: no steps");
  });

  it("flags steps that neither use nor run anything", () => {
    const workflow = good();
    workflow.jobs.web.steps = [{ name: "oops" } as never];
    expect(lintWorkflow(workflow, "ci.yml")).toContain("ci.yml: job web step 1: needs uses or run");
  });

  it("requires least-privilege permissions at workflow or job level", () => {
    const { permissions: _removed, ...withoutPermissions } = good();
    expect(lintWorkflow(withoutPermissions, "ci.yml")).toContain(
      "ci.yml: job web: no permissions (declare least privilege at workflow or job level)",
    );
    const jobLevel = {
      ...withoutPermissions,
      jobs: { web: { ...good().jobs.web, permissions: { contents: "read" } } },
    };
    expect(lintWorkflow(jobLevel, "ci.yml")).toEqual([]);
  });

  it("forbids pull_request_target", () => {
    const workflow = { ...good(), on: { pull_request_target: null } };
    expect(lintWorkflow(workflow, "ci.yml")).toContain(
      "ci.yml: pull_request_target is not allowed (it runs untrusted code with secrets)",
    );
  });
});

describe("labels need the labeled activity type", () => {
  const doc = (on: unknown) => ({
    name: "x",
    on,
    permissions: { contents: "read" },
    jobs: {
      a: {
        "runs-on": "ubuntu-latest",
        if: "${{ contains(github.event.pull_request.labels.*.name, 'e2e') }}",
        steps: [{ run: "echo hi" }],
      },
    },
  });
  it("flags a pull_request trigger that cannot fire on a label", () => {
    expect(lintWorkflow(doc({ pull_request: null }), "w.yml").join("\n")).toMatch(/labeled/);
    expect(lintWorkflow(doc({ pull_request: { types: ["opened"] } }), "w.yml").join("\n")).toMatch(
      /labeled/,
    );
  });
  it("accepts it when labeled is listed", () => {
    expect(lintWorkflow(doc({ pull_request: { types: ["opened", "labeled"] } }), "w.yml")).toEqual(
      [],
    );
  });
});
