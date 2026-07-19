import { describe, expect, it, vi } from "vitest";
import type { LinearClient } from "@linear/sdk";
import { updateControlPlaneSetupState } from "../../src/setup/control-plane-setup-state.js";
import {
  buildLegacyNeedsRevisionName,
  executeNeedsRevisionReplacementRepair,
  executeWorkflowStatusRepairs,
  hashAffectedIssueSet,
  validateTeamWorkflowHealth,
} from "../../src/setup/linear-workflow-status-repair.js";
import type { WorkflowStatusPlanEntry } from "../../src/setup/linear-setup-plan.js";

function buildRepairEntry(input: {
  existingStatusId: string;
  affectedIssueIds?: string[];
  affectedIssueSetHash?: string;
}): WorkflowStatusPlanEntry {
  const issueIds = input.affectedIssueIds ?? [];
  return {
    name: "Needs Revision",
    category: "unstarted",
    role: "transitional",
    present: true,
    existingType: "started",
    existingStatusId: input.existingStatusId,
    categoryMatches: false,
    action: "repair",
    creatable: true,
    repairStrategy: "replacement",
    affectedIssueCount: issueIds.length,
    affectedIssueSetHash:
      input.affectedIssueSetHash ?? hashAffectedIssueSet(issueIds),
  };
}

function createRepairMockClient(input?: {
  legacyStatusId?: string;
  issueIds?: string[];
  createFails?: boolean;
  migrateFailsOnIssueId?: string;
  existingReplacement?: { id: string; name: string; type: string };
}) {
  const legacyStatusId = input?.legacyStatusId ?? "legacy-status";
  const issueIds = [...(input?.issueIds ?? [])];
  let workflowStates = [
    {
      id: legacyStatusId,
      name: "Needs Revision",
      type: "started",
    },
    ...(input?.existingReplacement ? [input.existingReplacement] : []),
  ];

  const client = {
    issues: vi.fn(async () => ({
      nodes: issueIds.map((id) => ({ id })),
      pageInfo: { hasNextPage: false },
      fetchNext: vi.fn(),
    })),
    workflowStates: vi.fn(async () => ({
      nodes: workflowStates,
      pageInfo: { hasNextPage: false },
      fetchNext: vi.fn(),
    })),
    updateWorkflowState: vi.fn(async (id: string, args: { name?: string }) => {
      workflowStates = workflowStates.map((state) =>
        state.id === id ? { ...state, ...args, type: state.type } : state,
      );
      return {
        workflowState: Promise.resolve(
          workflowStates.find((state) => state.id === id),
        ),
      };
    }),
    createWorkflowState: vi.fn(async (args: { name: string; type: string }) => {
      if (input?.createFails) {
        throw new Error("create failed");
      }
      const created = {
        id: "replacement-status",
        name: args.name,
        type: args.type,
      };
      workflowStates = [...workflowStates, created];
      return { workflowState: Promise.resolve(created) };
    }),
    updateIssue: vi.fn(async (issueId: string, args: { stateId: string }) => {
      if (input?.migrateFailsOnIssueId === issueId) {
        throw new Error("migration failed");
      }
      const index = issueIds.indexOf(issueId);
      if (index >= 0) {
        issueIds.splice(index, 1);
      }
      return { issue: Promise.resolve({ id: issueId, stateId: args.stateId }) };
    }),
    archiveWorkflowState: vi.fn(async (stateId: string) => {
      workflowStates = workflowStates.filter((state) => state.id !== stateId);
    }),
  } as unknown as LinearClient;

  return {
    client,
    getWorkflowStates: () => workflowStates,
    getIssueIds: () => issueIds,
  };
}

describe("linear-workflow-status-repair", () => {
  it("detects stale issue-set hashes between preview and apply", async () => {
    const { client } = createRepairMockClient({
      legacyStatusId: "legacy-1",
      issueIds: ["issue-1"],
    });
    const entry = buildRepairEntry({
      existingStatusId: "legacy-1",
      affectedIssueIds: [],
    });

    await expect(
      executeNeedsRevisionReplacementRepair({
        client,
        teamId: "team-1",
        entry,
      }),
    ).rejects.toMatchObject({ code: "stale-issue-set" });
  });

  it("restores the original status name when replacement creation fails", async () => {
    const { client, getWorkflowStates } = createRepairMockClient({
      legacyStatusId: "legacy-1",
      createFails: true,
    });
    const entry = buildRepairEntry({
      existingStatusId: "legacy-1",
      affectedIssueIds: [],
    });

    await expect(
      executeNeedsRevisionReplacementRepair({
        client,
        teamId: "team-1",
        entry,
      }),
    ).rejects.toMatchObject({ code: "create-failed" });

    expect(getWorkflowStates().find((state) => state.id === "legacy-1")?.name).toBe(
      "Needs Revision",
    );
  });

  it("preserves both statuses when issue migration fails", async () => {
    const { client, getWorkflowStates } = createRepairMockClient({
      legacyStatusId: "legacy-1",
      issueIds: ["issue-1"],
      migrateFailsOnIssueId: "issue-1",
    });
    const entry = buildRepairEntry({
      existingStatusId: "legacy-1",
      affectedIssueIds: ["issue-1"],
    });

    await expect(
      executeNeedsRevisionReplacementRepair({
        client,
        teamId: "team-1",
        entry,
      }),
    ).rejects.toMatchObject({ code: "migration-incomplete" });

    const states = getWorkflowStates();
    expect(states.some((state) => state.name === "Needs Revision")).toBe(true);
    expect(
      states.some((state) =>
        state.name.startsWith("Needs Revision leg"),
      ),
    ).toBe(true);
  });

  it("reuses an existing replacement on retry", async () => {
    const { client } = createRepairMockClient({
      legacyStatusId: "legacy-1",
      existingReplacement: {
        id: "replacement-status",
        name: "Needs Revision",
        type: "unstarted",
      },
    });
    const entry = buildRepairEntry({
      existingStatusId: "legacy-1",
      affectedIssueIds: [],
    });

    const result = await executeNeedsRevisionReplacementRepair({
      client,
      teamId: "team-1",
      entry,
    });

    expect(result.replacementStatusId).toBe("replacement-status");
    expect(client.createWorkflowState).not.toHaveBeenCalled();
  });

  it("makes canonical validation healthy after replacement repair", async () => {
    const { client } = createRepairMockClient({
      legacyStatusId: "legacy-1",
      issueIds: [],
    });
    const entry = buildRepairEntry({
      existingStatusId: "legacy-1",
      affectedIssueIds: [],
    });

    await executeNeedsRevisionReplacementRepair({
      client,
      teamId: "team-1",
      entry,
    });

    const states = [
      { id: "s-backlog", name: "Backlog", category: "backlog" },
      { id: "s-rfp", name: "Ready for Planning", category: "unstarted" },
      { id: "s-planning", name: "Planning", category: "started" },
      { id: "s-rfb", name: "Ready for Build", category: "unstarted" },
      { id: "s-building", name: "Building", category: "started" },
      { id: "s-pr", name: "PR Open", category: "started" },
      { id: "s-pm", name: "PM Review", category: "started" },
      { id: "s-eng", name: "Engineering Review", category: "started" },
      { id: "s-rev", name: "Needs Revision", category: "unstarted" },
      { id: "s-revising", name: "Revising", category: "started" },
      { id: "s-rtm", name: "Ready to Merge", category: "started" },
      { id: "s-merging", name: "Merging", category: "started" },
      { id: "s-mtd", name: "Merged to Dev", category: "completed" },
      { id: "s-deployed", name: "Merged / Deployed", category: "completed" },
      { id: "s-blocked", name: "Blocked", category: "started" },
      { id: "s-canceled", name: "Canceled", category: "canceled" },
      { id: "s-dup", name: "Duplicate", category: "duplicate" },
    ];

    expect(validateTeamWorkflowHealth(states)).toBe(true);
  });

  it("does not clear downstream control-plane state when only linear is patched", async () => {
    const cwd = `/tmp/harness-repair-${Date.now()}`;
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { resolveLocalFilePaths } = await import("../../src/setup/setup-state.js");
    const paths = resolveLocalFilePaths(cwd);
    await mkdir(paths.harnessDir, { recursive: true });
    await writeFile(
      `${paths.harnessDir}/control-plane-setup.json`,
      `${JSON.stringify({
        version: 1,
        vercel: {
          projectId: "vercel-project",
          projectName: "harness",
          appliedFingerprint: "abc",
          appliedAt: "2026-01-01T00:00:00.000Z",
        },
        workflowModels: {
          plannerModelId: "planner",
          builderModelId: "builder",
        },
      })}\n`,
      "utf8",
    );

    const next = await updateControlPlaneSetupState(
      {
        linear: {
          teamMode: "existing",
          teamId: "team-1",
          teamKey: "WES",
          teamName: "Weston Product Lab",
          projectMode: "existing",
          projectId: "project-1",
          projectName: "Harness",
          statusCoverageComplete: true,
          appliedFingerprint: "linear-fp",
          appliedAt: "2026-01-02T00:00:00.000Z",
        },
      },
      cwd,
    );

    expect(next.vercel?.projectId).toBe("vercel-project");
    expect(next.workflowModels?.plannerModelId).toBe("planner");
    expect(next.linear?.teamKey).toBe("WES");
  });

  it("executes repair entries through executeWorkflowStatusRepairs", async () => {
    const { client } = createRepairMockClient({
      legacyStatusId: "legacy-1",
      issueIds: [],
    });
    const repaired = await executeWorkflowStatusRepairs({
      client,
      teamId: "team-1",
      entries: [
        buildRepairEntry({
          existingStatusId: "legacy-1",
          affectedIssueIds: [],
        }),
      ],
    });

    expect(repaired).toEqual(["status:Needs Revision"]);
  });

  it("builds deterministic legacy rename labels", () => {
    expect(buildLegacyNeedsRevisionName("67cce97f-d7ad-4f94-93d9-a14b922f55b8")).toBe(
      "Needs Revision leg 67cce97f",
    );
  });
});
