import { describe, expect, it, vi } from "vitest";
import { planOptionalReviewStatusMigration } from "../../src/setup/linear-optional-status-migrate.js";

describe("optional review status provisioning plans", () => {
  it("marks missing statuses as create", () => {
    const plan = planOptionalReviewStatusMigration([]);
    expect(plan.every((e) => e.action === "create")).toBe(true);
  });

  it("reuses exact matching statuses", () => {
    const plan = planOptionalReviewStatusMigration([
      { id: "1", name: "Plan Review", type: "started" },
      { id: "2", name: "Code Review", type: "started" },
      { id: "3", name: "Code Revision", type: "started" },
    ]);
    expect(plan.every((e) => e.action === "ok")).toBe(true);
  });

  it("fails closed on incompatible category", () => {
    const plan = planOptionalReviewStatusMigration([
      { id: "1", name: "Plan Review", type: "backlog" },
      { id: "2", name: "Code Review", type: "started" },
      { id: "3", name: "Code Revision", type: "started" },
    ]);
    expect(plan.find((e) => e.name === "Plan Review")?.action).toBe(
      "repair_category",
    );
  });

  it("matches status names case-insensitively", () => {
    const plan = planOptionalReviewStatusMigration([
      { id: "1", name: "plan review", type: "Started" },
      { id: "2", name: "CODE REVIEW", type: "started" },
      { id: "3", name: "Code Revision", type: "STARTED" },
    ]);
    expect(plan.every((e) => e.action === "ok")).toBe(true);
  });
});

describe("ensureOptionalReviewStatusesForConfiguredTeams conflict preflight", () => {
  it("stops before create when any team has a category conflict", async () => {
    vi.resetModules();
    vi.doMock("../../src/setup/linear-setup-client.js", () => ({
      createLinearSetupClient: () => ({}),
      listTeamWorkflowStates: async (_client: unknown, teamId: string) => {
        if (teamId === "team-conflict") {
          return [
            { id: "1", name: "Plan Review", type: "backlog" },
            { id: "2", name: "Code Review", type: "started" },
            { id: "3", name: "Code Revision", type: "started" },
          ];
        }
        return [
          { id: "a", name: "Plan Review", type: "started" },
          { id: "b", name: "Code Review", type: "started" },
          { id: "c", name: "Code Revision", type: "started" },
        ];
      },
      createLinearWorkflowState: vi.fn(async () => {
        throw new Error("create must not run after conflict preflight");
      }),
      isDuplicateWorkflowStateError: () => false,
    }));

    const { ensureOptionalReviewStatusesForConfiguredTeams } = await import(
      "../../src/setup/linear-optional-status-provision.js"
    );

    const result = await ensureOptionalReviewStatusesForConfiguredTeams({
      linearApiKey: "lin_test",
      config: {
        version: 1,
        repos: [
          {
            id: "app",
            targetRepo: "https://github.com/example/app",
            baseBranch: "main",
            productionBranch: "main",
          },
        ],
        allowedTargetRepos: ["https://github.com/example/app"],
      },
      teamIds: ["team-ok", "team-conflict"],
    });

    expect(result.conflict).toBe(true);
    expect(result.allTeamsReady).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.teams.some((t) => t.status === "conflict")).toBe(true);
  });
});
