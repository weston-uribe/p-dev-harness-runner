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
    expect(intended).toContain("p-dev-target-workflow-contract:v2");
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
