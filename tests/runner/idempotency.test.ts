import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";
import {
  assertPlanningEligibleStatus,
  checkPlanningIdempotency,
} from "../../src/runner/idempotency.js";

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    teamKey: "WES",
    eligibleStatuses: {
      planning: ["Ready for Planning"],
      implementation: ["Ready for Build"],
    },
    transitionalStatuses: {
      planningInProgress: "Planning",
      buildingInProgress: "Building",
      prOpen: "PR Open",
      pmReview: "PM Review",
      blocked: "Blocked",
      readyForBuild: "Ready for Build",
    },
  },
  repos: [],
  allowedTargetRepos: [],
};

const baseIssue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "WES-1",
  title: "Test",
  description: "",
  status: "Ready for Planning",
  projectName: null,
  teamName: null,
  teamKey: null,
  teamId: "team-1",
  url: null,
};

describe("planning idempotency", () => {
  it("skips when planning marker exists and issue is Ready for Build", () => {
    const issue = { ...baseIssue, status: "Ready for Build" };
    const comments = [
      {
        id: "c1",
        body: `## Implementation plan\n\nDone\n\n---\nharness-orchestrator-v1\nphase: planning\nrun_id: run-1\n---`,
      },
    ];

    const result = checkPlanningIdempotency(config, issue, comments, false);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("duplicate_phase_completed");
  });

  it("does not skip when --force is set", () => {
    const issue = { ...baseIssue, status: "Ready for Build" };
    const comments = [
      {
        id: "c1",
        body: `---\nharness-orchestrator-v1\nphase: planning\nrun_id: run-1\n---`,
      },
    ];

    const result = checkPlanningIdempotency(config, issue, comments, true);
    expect(result.skip).toBe(false);
  });

  it("rejects wrong status for planning", () => {
    const issue = { ...baseIssue, status: "Backlog" };
    expect(() => assertPlanningEligibleStatus(config, issue, false)).toThrow(
      /wrong_status/,
    );
  });

  it("allows Planning status when force is set", () => {
    const issue = { ...baseIssue, status: "Planning" };
    expect(() => assertPlanningEligibleStatus(config, issue, true)).not.toThrow();
  });

  it("allows Planning status for Plan Review revision recovery", () => {
    const issue = { ...baseIssue, status: "Planning" };
    expect(() =>
      assertPlanningEligibleStatus(config, issue, false, {
        allowPlanningInProgressForRevision: true,
      }),
    ).not.toThrow();
  });
});
