import { describe, expect, it } from "vitest";
import { resolveProductionSyncTeamScans } from "../../src/runner/production-sync-candidates.js";
import type { HarnessConfig } from "../../src/config/types.js";

describe("resolveProductionSyncTeamScans", () => {
  it("enumerates linearAssociations teams and projects (FRE + TT)", () => {
    const config = {
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: "runs",
      linear: { teamKey: "TT" },
      repos: [
        {
          id: "weston-uribe-portfolio",
          targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
          baseBranch: "dev",
          productionBranch: "main",
          linearAssociations: [
            {
              workspaceId: "ws",
              teamId: "team-fre",
              teamKey: "FRE",
              projectId: "proj-harness",
              projectName: "harness",
            },
            {
              workspaceId: "ws",
              teamId: "team-tt",
              teamKey: "TT",
              projectId: "proj-tt",
              projectName: "Test Project",
            },
          ],
        },
      ],
      allowedTargetRepos: [
        "https://github.com/weston-uribe/weston-uribe-portfolio",
      ],
    } as HarnessConfig;

    const scans = resolveProductionSyncTeamScans(
      config,
      "weston-uribe-portfolio",
    );
    expect(scans).toHaveLength(2);
    expect(scans.map((scan) => scan.teamKey).sort()).toEqual(["FRE", "TT"]);
    expect(scans.find((scan) => scan.teamKey === "FRE")?.projectNames).toEqual([
      "harness",
    ]);
  });

  it("falls back to linear.teamKey + linearProjects when associations absent", () => {
    const config = {
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: "runs",
      linear: { teamKey: "WES", teamId: "team-wes" },
      repos: [
        {
          id: "real-target",
          linearProjects: ["Private Target"],
          targetRepo: "https://github.com/owner/private-target",
          baseBranch: "dev",
          productionBranch: "main",
        },
      ],
      allowedTargetRepos: ["https://github.com/owner/private-target"],
    } as HarnessConfig;

    const scans = resolveProductionSyncTeamScans(config, "real-target");
    expect(scans).toEqual([
      {
        teamId: "team-wes",
        teamKey: "WES",
        projectNames: ["Private Target"],
      },
    ]);
  });
});
