import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/harness-reconcile-production.yml",
);

describe("harness-reconcile-production workflow", () => {
  const yaml = readFileSync(workflowPath, "utf8");

  it("schedules on */20 and invokes harness:reconcile-production", () => {
    expect(yaml).toContain('cron: "*/20 * * * *"');
    expect(yaml).toContain("harness:reconcile-production");
    expect(yaml).toContain("workflow_dispatch");
    expect(yaml).toContain("VERCEL_TOKEN");
    expect(yaml).toContain(
      "group: harness-reconcile-production-${{ github.event.inputs.repo || 'all' }}",
    );
  });

  it("does not overload the revision reconciler workflow", () => {
    const revision = readFileSync(
      path.join(repoRoot, ".github/workflows/harness-reconcile-revisions.yml"),
      "utf8",
    );
    expect(revision).not.toContain("reconcile-production");
    expect(yaml).not.toContain("reconcile-revision");
  });
});
