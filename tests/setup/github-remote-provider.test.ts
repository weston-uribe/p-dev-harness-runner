import { describe, expect, it } from "vitest";
import {
  MockGitHubRemoteSetupProvider,
  mapGitHubAccessErrorToStatus,
  mapGitHubSecretMetadataToStatus,
} from "../../src/setup/github-remote-provider.js";
import { HARNESS_ACTIONS_SECRET_NAMES } from "../../src/setup/remote-actions.js";
import { generateTargetWorkflowYaml } from "../../src/setup/target-workflow-setup.js";

describe("github-remote-provider", () => {
  it("maps GitHub secret metadata to present or missing only", () => {
    const statuses = mapGitHubSecretMetadataToStatus(
      ["LINEAR_API_KEY", "CURSOR_API_KEY"],
      HARNESS_ACTIONS_SECRET_NAMES,
    );

    expect(statuses).toEqual([
      { name: "HARNESS_CONFIG_JSON_B64", status: "missing" },
      { name: "LINEAR_API_KEY", status: "present" },
      { name: "CURSOR_API_KEY", status: "present" },
      { name: "HARNESS_GITHUB_TOKEN", status: "missing" },
      { name: "VERCEL_TOKEN", status: "missing" },
    ]);
  });

  it("maps auth errors to denied access status", () => {
    expect(mapGitHubAccessErrorToStatus(401)).toBe("denied");
    expect(mapGitHubAccessErrorToStatus(403)).toBe("denied");
    expect(mapGitHubAccessErrorToStatus(500)).toBe("unknown");
  });

  it("uses mocked provider without performing real remote writes", async () => {
    const provider = new MockGitHubRemoteSetupProvider({
      harnessRepoAccess: "available",
      harnessSecretStatuses: {
        LINEAR_API_KEY: "present",
      },
      targetRepoAccess: "available",
      existingWorkflowContent: null,
    });

    const harnessAccess = await provider.checkHarnessRepoAccess("owner/harness");
    const secretStatuses = await provider.listHarnessSecretStatuses(
      "owner/harness",
    );
    const workflow = generateTargetWorkflowYaml({
      harnessDispatchRepo: "owner/harness",
      repoConfigId: "target-app",
      targetRepoSlug: "owner/example-target-app",
      productionBranch: "main",
    });
    const workflowStatus = await provider.checkTargetWorkflowStatus({
      targetRepoSlug: "owner/example-target-app",
      workflowPath: ".github/workflows/trigger-harness-production-sync.yml",
      intendedWorkflowContent: workflow,
      productionBranch: "main",
    });

    expect(harnessAccess).toBe("available");
    expect(secretStatuses.find((entry) => entry.name === "LINEAR_API_KEY")).toEqual(
      { name: "LINEAR_API_KEY", status: "present" },
    );
    expect(workflowStatus.workflowStatus).toBe("missing");
    expect(provider.calls).toHaveLength(3);
    expect(JSON.stringify(provider.calls)).not.toContain("encrypted");
  });
});
