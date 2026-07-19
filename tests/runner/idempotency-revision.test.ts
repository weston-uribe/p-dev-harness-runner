import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";
import {
  assertRevisionEligibleStatus,
  checkRevisionIdempotency,
} from "../../src/runner/idempotency.js";
import { inferPhaseFromStatus } from "../../src/runner/phase-infer.js";

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    eligibleStatuses: {
      revision: ["Needs Revision"],
    },
    transitionalStatuses: {
      needsRevision: "Needs Revision",
      revisingInProgress: "Revising",
      pmReview: "PM Review",
    },
  },
  repos: [],
  allowedTargetRepos: ["https://github.com/o/r"],
};

const baseIssue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "WES-13",
  title: "Test",
  description: "",
  status: "Needs Revision",
  projectName: null,
  teamName: null,
  teamKey: null,
  teamId: "team-1",
  url: null,
};

const revisionMarker = `---\nharness-orchestrator-v1\nphase: revision\nrun_id: run-rev\npr_url: https://github.com/o/r/pull/4\npm_feedback_comment_id: pm-feedback-1\n---`;

describe("revision idempotency", () => {
  it("proceeds when Needs Revision has no matching revision marker", () => {
    const result = checkRevisionIdempotency(
      config,
      baseIssue,
      [{ id: "pm-feedback-1", body: "Please update copy." }],
      "pm-feedback-1",
      false,
    );

    expect(result.skip).toBe(false);
  });

  it("duplicate skips from Needs Revision when feedback already revised", () => {
    const result = checkRevisionIdempotency(
      config,
      baseIssue,
      [{ id: "rev-1", body: revisionMarker }],
      "pm-feedback-1",
      false,
    );

    expect(result.skip).toBe(true);
  });

  it("duplicate skips from PM Review when feedback already revised", () => {
    const result = checkRevisionIdempotency(
      config,
      { ...baseIssue, status: "PM Review" },
      [{ id: "rev-1", body: revisionMarker }],
      "pm-feedback-1",
      false,
    );

    expect(result.skip).toBe(true);
  });

  it("returns wrong_status reason for PM Review without matching marker", () => {
    const result = checkRevisionIdempotency(
      config,
      { ...baseIssue, status: "PM Review" },
      [],
      "pm-feedback-1",
      false,
    );

    expect(result.skip).toBe(false);
    expect(result.reason).toContain("wrong_status");
  });

  it("allows retry from Revising with force", () => {
    expect(() =>
      assertRevisionEligibleStatus(
        config,
        { ...baseIssue, status: "Revising" },
        true,
      ),
    ).not.toThrow();
  });
});

describe("inferPhaseFromStatus revision routing", () => {
  it("routes Needs Revision to revision", () => {
    expect(inferPhaseFromStatus("Needs Revision", config).phase).toBe("revision");
  });

  it("does not route PM Review to revision", () => {
    expect(inferPhaseFromStatus("PM Review", config).phase).toBe("none");
  });
});
