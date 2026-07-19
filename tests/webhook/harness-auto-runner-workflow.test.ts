import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const liveWorkflowPath = path.join(repoRoot, ".github/workflows/harness-auto-runner.yml");
const fixtureWorkflowPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/workflows/harness-auto-runner-with-production-sync.yml",
);

function extractJobSection(workflow: string, jobName: string): string {
  const marker = `${jobName}:`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`Job ${jobName} not found`);
  }
  const rest = workflow.slice(start + marker.length);
  const nextJob = rest.search(/\n  [a-z][a-z0-9-]+:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}

function assertHarnessWorkflowContracts(workflow: string, label: string): void {
  describe(`${label} workflow contract`, () => {
    it("subscribes to production_promoted repository_dispatch", () => {
      expect(workflow).toContain("production_promoted");
      expect(workflow).toContain("linear_issue_status_changed");
    });

    it("uses request_id workflow_dispatch input and client_payload.requestId", () => {
      expect(workflow).toContain("request_id:");
      expect(workflow).toContain("client_payload.requestId");
      expect(workflow).not.toMatch(/^\s+issue:\s*$/m);
    });

    it("defines gate job with claim, resolve-route, and without required concurrency", () => {
      const gate = extractJobSection(workflow, "gate");
      expect(gate).toContain("harness:claim-job-request");
      expect(gate).toContain("harness:resolve-route");
      expect(gate).toContain("--request-id");
      expect(gate).not.toMatch(/^\s+concurrency:/m);
      expect(gate).toContain("GITHUB_TOKEN");
      expect(gate).not.toContain("issue_key:");
    });

    it("run-harness keeps per-request concurrency without canceling in-progress work", () => {
      const runHarness = extractJobSection(workflow, "run-harness");
      expect(runHarness).toContain(
        "harness-req-${{ needs.gate.outputs.request_id }}",
      );
      expect(runHarness).toContain("cancel-in-progress: false");
      expect(runHarness).not.toContain("harness-merge-");
    });

    it("run-merge uses repo/base merge concurrency with queued pending runs", () => {
      const runMerge = extractJobSection(workflow, "run-merge");
      expect(runMerge).toContain("harness-merge-${{ needs.gate.outputs.merge_concurrency_group }}");
      expect(runMerge).toContain("cancel-in-progress: false");
      expect(runMerge).toContain("queue: max");
      expect(runMerge).toContain("harness:run");
      expect(runMerge).toContain("--phase merge");
      expect(runMerge).toContain("harness:doctor -- --profile merge");
      expect(runMerge).toContain("CURSOR_API_KEY");
    });

    it("does not treat gate concurrency as sole duplicate protection", () => {
      const gate = extractJobSection(workflow, "gate");
      const runHarness = extractJobSection(workflow, "run-harness");
      expect(gate).not.toMatch(/^\s+concurrency:/m);
      expect(runHarness).toMatch(/^\s+concurrency:/m);
    });

    it("defines sync-production job gated on production_promoted", () => {
      expect(workflow).toContain("sync-production:");
      expect(workflow).toContain("github.event.action == 'production_promoted'");
      expect(workflow).toContain("harness:sync-production");
    });

    it("uses harness secrets for sync without CURSOR_API_KEY", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain("LINEAR_API_KEY");
      expect(syncSection).toContain("HARNESS_GITHUB_TOKEN");
      expect(syncSection).not.toContain("CURSOR_API_KEY");
      expect(syncSection).not.toContain("harness:doctor");
    });

    it("supports workflow_dispatch sync_repo input", () => {
      expect(workflow).toContain("sync_repo:");
    });

    it("supports workflow_dispatch sync_dry_run input defaulting to true", () => {
      expect(workflow).toContain("sync_dry_run:");
      expect(workflow).toMatch(/sync_dry_run:[\s\S]*default:\s*"true"/);
    });

    it("supports review phases in workflow_dispatch phase input and gate validation", () => {
      expect(workflow).toContain("plan_review");
      expect(workflow).toContain("code_review");
      expect(workflow).toContain("code_revision");
      const gate = extractJobSection(workflow, "gate");
      expect(gate).toMatch(
        /auto\|planning\|plan_review\|implementation\|handoff\|code_review\|code_revision\|revision\|merge/,
      );
    });

    it("uses managed GitHub workflow state and public runner env on harness jobs", () => {
      const gate = extractJobSection(workflow, "gate");
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      const syncSection = extractJobSection(workflow, "sync-production");
      for (const section of [gate, runHarness, runMerge]) {
        expect(section).toContain("P_DEV_PUBLIC_RUNNER_MODE: \"1\"");
        expect(section).toContain("P_DEV_WORKFLOW_STATE_STORE_MODE: managed_github");
        expect(section).toContain("P_DEV_WORKFLOW_STATE_REPOSITORY:");
        expect(section).toContain("P_DEV_STATE_GITHUB_TOKEN:");
      }
      expect(syncSection).not.toContain("P_DEV_WORKFLOW_STATE_STORE_MODE");
    });

    it("validates sync_dry_run is true or false for workflow_dispatch", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain("Validate sync dry run");
      expect(syncSection).toContain("Invalid sync_dry_run value. Expected true or false.");
    });

    it("passes --dry-run to sync-production when dry_run is true", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain('if [ "$SYNC_DRY_RUN" = "true" ]; then');
      expect(syncSection).toContain("SYNC_ARGS+=(--dry-run)");
      expect(syncSection).toContain("Dry run:");
    });

    it("does not dry-run production_promoted repository_dispatch sync", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain('echo "dry_run=false" >> "$GITHUB_OUTPUT"');
    });

    it("supports force workflow_dispatch recovery input", () => {
      expect(workflow).toContain("force:");
      expect(workflow).toContain('FORCE_FLAG="--force"');
    });

    it("validates request id format in gate job without issue key regex", () => {
      const gate = extractJobSection(workflow, "gate");
      expect(gate).toContain("Invalid request id format.");
      expect(gate).not.toContain("^[A-Z]+-[0-9]+$");
    });

    it("validates sync repo id format without hard-coded allowlist", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain("^[a-z][a-z0-9-]*$");
      expect(syncSection).not.toContain("target-app|harness");
    });

    it("loads private operator config from HARNESS_CONFIG_JSON_B64 on harness jobs", () => {
      expect(workflow).toContain("HARNESS_CONFIG_JSON_B64: ${{ secrets.HARNESS_CONFIG_JSON_B64 }}");
      const gate = extractJobSection(workflow, "gate");
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(gate).toContain("HARNESS_CONFIG_JSON_B64");
      expect(runHarness).toContain("HARNESS_CONFIG_JSON_B64");
      expect(runMerge).toContain("HARNESS_CONFIG_JSON_B64");
      expect(syncSection).toContain("HARNESS_CONFIG_JSON_B64");
    });

    it("passes HARNESS_CONFIG_FINGERPRINT on run-merge so cloud_config_stale cannot trip on a missing var", () => {
      const runMerge = extractJobSection(workflow, "run-merge");
      expect(runMerge).toContain(
        "HARNESS_CONFIG_FINGERPRINT: ${{ vars.HARNESS_CONFIG_FINGERPRINT }}",
      );
    });

    it("wires evaluation environment on run-merge but not gate or sync-production", () => {
      const gate = extractJobSection(workflow, "gate");
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      const syncSection = extractJobSection(workflow, "sync-production");

      expect(runHarness).toContain("P_DEV_EVALUATION_PROVIDER");
      expect(runHarness).toContain("LANGFUSE_SECRET_KEY");
      expect(runMerge).toContain("P_DEV_EVALUATION_PROVIDER");
      expect(runMerge).toContain("LANGFUSE_SECRET_KEY");

      expect(gate).not.toContain("LANGFUSE_SECRET_KEY");
      expect(syncSection).not.toContain("LANGFUSE_SECRET_KEY");
      expect(syncSection).not.toContain("P_DEV_EVALUATION_PROVIDER");
    });

    it("resolves dual-commit provenance before harness jobs via GITHUB_ENV", () => {
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      for (const section of [runHarness, runMerge]) {
        expect(section).toContain("Resolve runtime provenance");
        expect(section).toContain("write-github-provenance-env.ts");
        expect(section).not.toMatch(
          /^\s+LANGFUSE_RELEASE:\s*\$\{\{\s*github\.sha\s*\}\}/m,
        );
      }
    });

    it("forwards dispatch metadata to sync-production CLI", () => {
      const syncSection = extractJobSection(workflow, "sync-production");
      expect(syncSection).toContain("--source-repo");
      expect(syncSection).toContain("--production-branch");
      expect(syncSection).toContain("--ref");
    });

    it("uploads public-safe harness artifacts without issue-key paths", () => {
      const runHarness = extractJobSection(workflow, "run-harness");
      const runMerge = extractJobSection(workflow, "run-merge");
      for (const section of [runHarness, runMerge]) {
        expect(section).toContain("name: harness-run-${{ github.run_id }}");
        expect(section).toContain("runs/public-summary-${{ github.run_id }}.json");
        expect(section).not.toContain("runs/${{ needs.gate.outputs.issue_key }}");
      }
    });

    it("never references HARNESS_ISSUE_KEY or issue-key env dumps in public jobs", () => {
      expect(workflow).not.toContain("HARNESS_ISSUE_KEY");
      expect(workflow).not.toContain("ISSUE_KEY: ${{ env.");
      expect(workflow).not.toContain("--issue \"$HARNESS_ISSUE_KEY\"");
    });
  });
}

describe("harness-auto-runner workflow contracts", () => {
  assertHarnessWorkflowContracts(readFileSync(liveWorkflowPath, "utf8"), "live");
  assertHarnessWorkflowContracts(readFileSync(fixtureWorkflowPath, "utf8"), "fixture");
});

describe("harness-auto-runner concurrency behavior contracts", () => {
  const workflow = readFileSync(liveWorkflowPath, "utf8");
  const runHarness = extractJobSection(workflow, "run-harness");
  const runMerge = extractJobSection(workflow, "run-merge");

  it("duplicate same-request non-merge dispatch queues via run-harness concurrency without cancel", () => {
    expect(runHarness).toContain("harness-req-${{ needs.gate.outputs.request_id }}");
    expect(runHarness).toContain("cancel-in-progress: false");
  });

  it("duplicate same-issue merge dispatch queues via run-merge concurrency without cancel", () => {
    expect(runMerge).toContain("harness-merge-${{ needs.gate.outputs.merge_concurrency_group }}");
    expect(runMerge).toContain("cancel-in-progress: false");
    expect(runMerge).toContain("queue: max");
  });

  it("different requests in non-merge phases use distinct run-harness groups", () => {
    expect(runHarness).toContain("needs.gate.outputs.request_id");
  });

  it("different issues targeting same repo/base branch share merge queue group output", () => {
    expect(runMerge).toContain("needs.gate.outputs.merge_concurrency_group");
  });
});
