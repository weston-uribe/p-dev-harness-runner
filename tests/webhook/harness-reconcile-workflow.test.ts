import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reconcileWorkflowPath = path.join(
  repoRoot,
  ".github/workflows/harness-reconcile-revisions.yml",
);
const inspectWorkflowPath = path.join(
  repoRoot,
  ".github/workflows/evaluation-inspect-langfuse.yml",
);

describe("harness reconcile revisions workflow", () => {
  const workflow = readFileSync(reconcileWorkflowPath, "utf8");

  it("uses generic reconcile-workflow command instead of FRE-3 seed", () => {
    expect(workflow).toContain("harness:reconcile-workflow");
    expect(workflow).not.toContain("FRE-3");
    expect(workflow).not.toContain("harness:reconcile-revision");
    expect(workflow).not.toContain("harness:reconcile-merge");
  });

  it("loads managed GitHub workflow state and public runner env during reconciliation", () => {
    expect(workflow).toContain("P_DEV_WORKFLOW_STATE_STORE_MODE: managed_github");
    expect(workflow).toContain('P_DEV_PUBLIC_RUNNER_MODE: "1"');
    expect(workflow).toContain("P_DEV_STATE_GITHUB_TOKEN:");
  });

  it("uses request_id workflow_dispatch input instead of issue", () => {
    expect(workflow).toContain("request_id:");
    expect(workflow).not.toMatch(/^\s+issue:\s*$/m);
  });

  it("writes aggregate-only reconcile summary", () => {
    expect(workflow).toContain("Write reconcile summary");
    expect(workflow).toContain("Candidates found:");
    expect(workflow).toContain("Dispatched:");
  });
});

describe("evaluation inspect langfuse workflow", () => {
  const workflow = readFileSync(inspectWorkflowPath, "utf8");

  it("uses request_id workflow input", () => {
    expect(workflow).toContain("request_id:");
    expect(workflow).not.toContain("issue_key:");
  });

  it("enables public runner mode and managed state env", () => {
    expect(workflow).toContain('P_DEV_PUBLIC_RUNNER_MODE: "1"');
    expect(workflow).toContain("P_DEV_WORKFLOW_STATE_STORE_MODE: managed_github");
    expect(workflow).toContain("P_DEV_STATE_GITHUB_TOKEN:");
  });

  it("does not hard-code weston-uribe/p-dev-harness", () => {
    expect(workflow).not.toContain("weston-uribe/p-dev-harness");
    expect(workflow).not.toContain("weston-uribe/p-dev-harness-runner");
  });

  it("does not silently ignore inspect CLI failures", () => {
    expect(workflow).not.toMatch(/evaluation:inspect-langfuse[^\n]*\|\| true/);
    const inspectStep =
      workflow.match(
        /- name: Run Langfuse inspect[\s\S]*?(?=\n      - name:)/,
      )?.[0] ?? "";
    expect(inspectStep).not.toContain("|| true");
  });

  it("is inspect-only with no reprojection or artifact-cache download", () => {
    expect(workflow).not.toContain("reproject-dry-run");
    expect(workflow).not.toContain("reproject-apply");
    expect(workflow).not.toContain("evaluation:reproject-langfuse");
    expect(workflow).not.toContain("runs/.artifact-cache");
    expect(workflow).not.toContain("Download run artifacts");
    expect(workflow).not.toContain("gh run download");
    expect(workflow).not.toMatch(/^\s*mode:/m);
    expect(workflow).not.toContain("tee ");
    expect(workflow).not.toContain(".stdout.json");
  });

  it("asserts public-summary acceptance gates", () => {
    expect(workflow).toContain("Assert Langfuse inspect acceptance");
    expect(workflow).toContain("acceptance.complete");
    expect(workflow).toContain("generationCostComplete");
    expect(workflow).toContain("requiredGenerationCount");
    expect(workflow).toContain("incompleteRequiredGenerationCount");
    expect(workflow).toContain("privacyValidationPassed");
    expect(workflow).toContain("assertPublicSafe");
    expect(workflow).toContain("Malformed Langfuse inspect report JSON");
  });

  it("uploads a single public-safe summary with one-day retention", () => {
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("Upload public-safe summary");
    expect(workflow).toContain("eval-inspect-${{ github.run_id }}");
    expect(workflow).toContain(
      "runs/evaluation-reports/public-inspect-${{ github.run_id }}.json",
    );
    expect(workflow).toContain("retention-days: 1");
    expect(workflow).not.toMatch(/path:\s*runs\/evaluation-reports\/\s*$/m);
    expect(workflow).not.toContain("Upload redacted report");
    expect(workflow).not.toContain("langfuse-inspect-${{ github.run_id }}");
  });
});
