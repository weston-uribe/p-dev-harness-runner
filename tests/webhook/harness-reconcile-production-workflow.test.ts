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
    expect(yaml).toContain("P_DEV_EVALUATION_PROVIDER");
    expect(yaml).toContain("LANGFUSE_SECRET_KEY");
    expect(yaml).toContain("group: harness-production-sync");
    expect(yaml).toContain("cancel-in-progress: false");
    expect(yaml).not.toContain("harness-reconcile-production-");
  });

  it("shares the exact concurrency group with event-driven sync-production", () => {
    const autoRunner = readFileSync(
      path.join(repoRoot, ".github/workflows/harness-auto-runner.yml"),
      "utf8",
    );
    const syncJob = autoRunner.slice(autoRunner.indexOf("sync-production:"));
    expect(syncJob).toContain("group: harness-production-sync");
    expect(syncJob).toContain("cancel-in-progress: false");
    expect(yaml).toContain("group: harness-production-sync");
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
