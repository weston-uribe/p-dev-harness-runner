import { describe, expect, it } from "vitest";
import {
  buildTargetWorkflowBranchName,
  compareTargetWorkflowContent,
  generateTargetWorkflowYaml,
  previewTargetWorkflowSetup,
} from "../../src/setup/target-workflow-setup.js";

describe("target-workflow-setup", () => {
  it("generates workflow YAML using resolved harness dispatch repo", () => {
    const yaml = generateTargetWorkflowYaml({
      harnessDispatchRepo: "dispatch-org/dispatch-repo",
      repoConfigId: "target-app",
      targetRepoSlug: "owner/example-target-app",
      productionBranch: "main",
    });

    expect(yaml).toContain(
      "https://api.github.com/repos/dispatch-org/dispatch-repo/dispatches",
    );
    expect(yaml).not.toContain("weston-uribe/agentic-product-development-harness");
    expect(yaml).toContain("--arg repo target-app");
    expect(yaml).toContain("--arg source owner/example-target-app");
    expect(yaml).toContain("branches: [main]");
  });

  it("compares workflow content including stale archived dispatch and contract version", () => {
    const intended = generateTargetWorkflowYaml({
      harnessDispatchRepo: "owner/harness",
      repoConfigId: "target-app",
      targetRepoSlug: "owner/example-target-app",
      productionBranch: "main",
    });

    expect(compareTargetWorkflowContent(null, intended)).toBe("missing");
    expect(compareTargetWorkflowContent(intended, intended)).toBe("present");
    expect(compareTargetWorkflowContent("different", intended)).toBe(
      "contract_outdated",
    );

    const archived = intended.replaceAll(
      "owner/harness",
      "weston-uribe/p-dev-harness",
    );
    expect(compareTargetWorkflowContent(archived, intended)).toBe(
      "stale_dispatch_target",
    );
    expect(intended).toContain("p-dev-target-workflow-contract:v3");
    expect(intended).toMatch(/^# p-dev-target-workflow-contract:v3$/m);
    expect(intended).not.toContain("<!--");
  });

  it("classifies installed HTML-prefixed v2 workflows as contract_outdated needing upgrade", () => {
    const intended = generateTargetWorkflowYaml({
      harnessDispatchRepo: "weston-uribe/p-dev-harness-runner",
      repoConfigId: "weston-uribe-portfolio",
      targetRepoSlug: "weston-uribe/weston-uribe-portfolio",
      productionBranch: "main",
    });
    const invalidV2 = [
      "<!-- p-dev-target-workflow-contract:v2",
      "contract_version: 2",
      "harness_dispatch_repo: weston-uribe/p-dev-harness-runner",
      "repo_config_id: weston-uribe-portfolio",
      "production_branch: main",
      "-->",
      intended.split("\n").slice(6).join("\n"),
    ].join("\n");

    expect(compareTargetWorkflowContent(invalidV2, intended)).toBe(
      "contract_outdated",
    );
    expect(compareTargetWorkflowContent(intended, intended)).toBe("present");
  });

  it("builds branch/PR preview without direct production branch writes", () => {
    const preview = previewTargetWorkflowSetup({
      repoConfigId: "target-app",
      targetRepo: "https://github.com/owner/example-target-app",
      productionBranch: "main",
      harnessDispatchRepo: {
        repo: "owner/harness",
        source: "explicit-config",
        resolved: true,
      },
      workflowStatus: "missing",
    });

    expect(preview.plan.branchName).toBe(
      buildTargetWorkflowBranchName("target-app"),
    );
    expect(preview.plan.directProductionBranchWrite).toBe(false);
    expect(preview.workflowPreviewSummary).toContain(
      "Direct production branch write: never",
    );
    expect(preview.manualInstructions.join("\n")).toContain("owner/harness");
  });
});
