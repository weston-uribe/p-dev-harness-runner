import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedLinearAssociation } from "../../src/config/resolve-linear-workspace.js";
import { readControlPlaneSetupState } from "../../src/setup/control-plane-setup-state.js";
import { writeControlPlaneSetupState } from "../../src/setup/control-plane-setup-state.js";
import { summarizeLinearWorkspaceStatus } from "../../src/setup/control-plane-readiness.js";
import { requiredCreatableStatuses } from "../../src/setup/linear-status-contract.js";
import { formatLinearEntityHealthLabel } from "../../src/setup/linear-entity-health-label.js";
import { verifyLinearWorkspaceAssociations } from "../../src/setup/linear-workspace-verify.js";
import type { LinearClient } from "@linear/sdk";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempCwd(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "linear-verify-"));
  tempDirs.push(dir);
  return dir;
}

function association(
  overrides: Partial<ResolvedLinearAssociation> = {},
): ResolvedLinearAssociation {
  return {
    workspaceId: "ws-1",
    teamId: "team-1",
    teamKey: "TT",
    teamName: "Test Team",
    projectId: "project-1",
    projectName: "Test Project",
    targetRepo: "https://github.com/acme/app",
    repoConfigId: "repo-1",
    ...overrides,
  };
}

function completeRequiredWorkflowStates() {
  return requiredCreatableStatuses().map((status, index) => ({
    id: `state-${index}`,
    name: status.name,
    type: status.category,
  }));
}

describe("formatLinearEntityHealthLabel", () => {
  it("never exposes raw health enums", () => {
    expect(formatLinearEntityHealthLabel("healthy")).toBe("Verified");
    expect(formatLinearEntityHealthLabel("verification_pending")).toBe(
      "Needs verification",
    );
    expect(formatLinearEntityHealthLabel("needs_repair")).toBe(
      "Needs attention",
    );
    expect(formatLinearEntityHealthLabel("unavailable")).toBe("Unavailable");
    expect(formatLinearEntityHealthLabel(undefined)).toBe("Needs verification");
    expect(formatLinearEntityHealthLabel(undefined, { drift: true })).toBe(
      "Needs attention",
    );
  });
});

describe("verifyLinearWorkspaceAssociations", () => {
  it("does not treat optionalReviewProvisioning.allTeamsReady as required coverage", async () => {
    const cwd = await tempCwd();
    await writeControlPlaneSetupState(
      {
        version: 1,
        optionalReviewProvisioning: {
          allTeamsReady: true,
          conflict: false,
          partial: false,
          retryable: false,
          message: "optional review ready",
          recordedAt: "2026-07-18T00:00:00.000Z",
          teams: [{ teamId: "team-1", status: "ready", created: [] }],
        },
        linearWorkspace: {
          workspaceId: "ws-1",
          workspaceName: "Linear workspace",
          teams: [
            {
              teamId: "team-1",
              teamKey: "TT",
              teamName: "Test Team",
              health: "verification_pending",
              projects: [
                {
                  projectId: "project-1",
                  projectName: "Test Project",
                  health: "verification_pending",
                },
              ],
            },
          ],
        },
      },
      cwd,
    );

    const result = await verifyLinearWorkspaceAssociations({
      cwd,
      linearApiKey: "lin_test",
      workspaceId: "ws-1",
      workspaceName: "Example Org",
      associations: [association()],
      client: {} as LinearClient,
      getProject: async () => ({
        id: "project-1",
        name: "Test Project",
        teamIds: ["team-1"],
      }),
      // Incomplete required statuses despite optional review readiness.
      listWorkflowStates: async () => [
        { id: "s1", name: "Ready for Planning", type: "unstarted" },
      ],
    });

    expect(result.statusCoverageComplete).toBe(false);
    expect(result.evidence.teams[0]?.health).toBe("verification_pending");
    expect(result.evidence.teams[0]?.projects[0]?.health).toBe(
      "verification_pending",
    );
    expect(
      formatLinearEntityHealthLabel(result.evidence.teams[0]?.health),
    ).toBe("Needs verification");

    const persisted = await readControlPlaneSetupState(cwd);
    const summary = summarizeLinearWorkspaceStatus({ state: persisted });
    expect(summary.statusCoverageComplete).toBe(false);
    expect(persisted?.optionalReviewProvisioning?.allTeamsReady).toBe(true);
  });

  it("marks associations Verified when the complete required workflow-state set is present", async () => {
    const cwd = await tempCwd();
    const listWorkflowStates = vi.fn(async () => completeRequiredWorkflowStates());

    const result = await verifyLinearWorkspaceAssociations({
      cwd,
      linearApiKey: "lin_test",
      workspaceId: "ws-1",
      workspaceName: "Example Org",
      associations: [association()],
      client: {} as LinearClient,
      getProject: async () => ({
        id: "project-1",
        name: "Test Project",
        teamIds: ["team-1"],
      }),
      listWorkflowStates,
    });

    expect(listWorkflowStates).toHaveBeenCalledWith({}, "team-1");
    expect(result.statusCoverageComplete).toBe(true);
    expect(result.evidence.teams[0]?.health).toBe("healthy");
    expect(result.evidence.teams[0]?.projects[0]?.health).toBe("healthy");
    expect(result.evidence.teams[0]?.lastVerifiedAt).toBeTruthy();
    expect(
      formatLinearEntityHealthLabel(result.evidence.teams[0]?.health),
    ).toBe("Verified");

    const persisted = await readControlPlaneSetupState(cwd);
    const summary = summarizeLinearWorkspaceStatus({ state: persisted });
    expect(summary.statusCoverageComplete).toBe(true);
    expect(summary.configured).toBe(true);
  });

  it("marks a project unavailable when it no longer exists on Linear", async () => {
    const cwd = await tempCwd();
    const result = await verifyLinearWorkspaceAssociations({
      cwd,
      linearApiKey: "lin_test",
      workspaceId: "ws-1",
      workspaceName: "Example Org",
      associations: [association()],
      client: {} as LinearClient,
      getProject: async () => null,
      listWorkflowStates: async () => completeRequiredWorkflowStates(),
    });

    expect(result.statusCoverageComplete).toBe(false);
    expect(result.evidence.teams[0]?.health).toBe("unavailable");
    expect(result.evidence.teams[0]?.projects[0]?.health).toBe("unavailable");
  });
});
