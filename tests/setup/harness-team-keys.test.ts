import { describe, expect, it } from "vitest";
import {
  deriveHarnessTeamKeys,
  issueKeyMatchesHarnessTeamKeys,
  parseHarnessTeamKeys,
} from "../../src/setup/harness-team-keys.js";
import { deriveHarnessTeamKeyFromControlPlane } from "../../src/setup/derive-harness-team-key.js";
import { validateIssueKeyTeam } from "../../src/webhook/extract-issue-key.js";

describe("harness team keys", () => {
  it("parses comma-separated allowlists", () => {
    expect(parseHarnessTeamKeys("TT, FRE")).toEqual(["TT", "FRE"]);
    expect(parseHarnessTeamKeys("fre")).toEqual(["FRE"]);
  });

  it("matches issue keys against any allowlisted team", () => {
    expect(issueKeyMatchesHarnessTeamKeys("FRE-3", ["TT", "FRE"])).toBe(true);
    expect(issueKeyMatchesHarnessTeamKeys("TT-1", ["TT", "FRE"])).toBe(true);
    expect(issueKeyMatchesHarnessTeamKeys("WES-9", ["TT", "FRE"])).toBe(false);
  });

  it("derives sorted unique keys from workspace teams", () => {
    expect(
      deriveHarnessTeamKeys({
        linearTeamKey: "TT",
        workspaceTeamKeys: ["FRE", "TT"],
      }),
    ).toBe("FRE,TT");
  });

  it("derives from control-plane workspace teams", () => {
    expect(
      deriveHarnessTeamKeyFromControlPlane({
        linearWorkspace: {
          workspaceId: "ws",
          workspaceName: "ws",
          teams: [
            {
              teamId: "t1",
              teamKey: "TT",
              teamName: "Test Team",
              projects: [],
              health: "healthy",
            },
            {
              teamId: "t2",
              teamKey: "FRE",
              teamName: "fresh",
              projects: [],
              health: "healthy",
            },
          ],
          appliedAt: new Date().toISOString(),
        },
      } as never),
    ).toBe("FRE,TT");
  });

  it("validateIssueKeyTeam accepts comma-separated HARNESS_TEAM_KEY", () => {
    expect(validateIssueKeyTeam("FRE-3", "TT,FRE")).toBe(true);
    expect(validateIssueKeyTeam("TT-1", "TT,FRE")).toBe(true);
    expect(validateIssueKeyTeam("WES-1", "TT,FRE")).toBe(false);
  });
});
