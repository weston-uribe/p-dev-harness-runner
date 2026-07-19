import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";
import {
  evaluateRevisionReconcile,
  revisionGenerationFromPmFeedback,
} from "../../src/runner/revision-reconcile.js";

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

const needsRevisionIssue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "FRE-3",
  title: "Test",
  description: "",
  status: "Needs Revision",
  projectName: null,
  teamName: null,
  teamKey: "FRE",
  teamId: "team-1",
  url: null,
};

const handoff = {
  id: "handoff-1",
  body: `Handoff\n\n---\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-handoff\npr_url: https://github.com/o/r/pull/39\n---`,
  createdAt: "2026-07-18T18:15:42.000Z",
};

const pmFeedback = {
  id: "ab390a10-00eb-419d-ab91-0d9d846c85af",
  body: "Light mode is broken across the portfolio. Fix all contrast issues.",
  createdAt: "2026-07-18T18:25:54.000Z",
};

const revisionMarker = {
  id: "rev-1",
  body: `Done\n\n---\nharness-orchestrator-v1\nphase: revision\nrun_id: run-rev\npm_feedback_comment_id: ${pmFeedback.id}\n---`,
  createdAt: "2026-07-18T19:00:00.000Z",
};

const harnessComment = {
  id: "harness-1",
  body: `---\nharness-orchestrator-v1\nphase: planning\nrun_id: run-plan\n---`,
  createdAt: "2026-07-18T18:20:00.000Z",
};

describe("evaluateRevisionReconcile", () => {
  it("records pending when Needs Revision arrives before feedback", () => {
    const result = evaluateRevisionReconcile({
      config,
      issue: needsRevisionIssue,
      comments: [handoff],
      trigger: "issue_status",
    });
    expect(result).toEqual({
      action: "record_pending",
      pmFeedbackCommentId: null,
      reason: "pending_pm_feedback",
    });
  });

  it("dispatches when feedback already exists before Needs Revision", () => {
    const result = evaluateRevisionReconcile({
      config,
      issue: needsRevisionIssue,
      comments: [handoff, pmFeedback],
      trigger: "issue_status",
    });
    expect(result.action).toBe("dispatch_revision");
    expect(result.pmFeedbackCommentId).toBe(pmFeedback.id);
  });

  it("dispatches when comment arrives after status (latest feedback)", () => {
    const result = evaluateRevisionReconcile({
      config,
      issue: needsRevisionIssue,
      comments: [handoff, pmFeedback],
      trigger: "comment_create",
      commentId: pmFeedback.id,
      commentBody: pmFeedback.body,
    });
    expect(result.action).toBe("dispatch_revision");
    expect(result.pmFeedbackCommentId).toBe(pmFeedback.id);
  });

  it("ignores comment while issue is still in PM Review", () => {
    const result = evaluateRevisionReconcile({
      config,
      issue: { ...needsRevisionIssue, status: "PM Review" },
      comments: [handoff, pmFeedback],
      trigger: "comment_create",
      commentId: pmFeedback.id,
      commentBody: pmFeedback.body,
    });
    expect(result.action).toBe("ignore");
    expect(result.reason).toContain("wrong_status");
  });

  it("skips duplicate for same feedback generation", () => {
    const result = evaluateRevisionReconcile({
      config,
      issue: needsRevisionIssue,
      comments: [handoff, pmFeedback, revisionMarker],
      trigger: "issue_status",
    });
    expect(result.action).toBe("skip_duplicate");
    expect(result.pmFeedbackCommentId).toBe(pmFeedback.id);
  });

  it("dispatches newer feedback as a new generation", () => {
    const newer = {
      id: "pm-feedback-2",
      body: "Still broken on UKME cards.",
      createdAt: "2026-07-18T20:00:00.000Z",
    };
    const result = evaluateRevisionReconcile({
      config,
      issue: needsRevisionIssue,
      comments: [handoff, pmFeedback, revisionMarker, newer],
      trigger: "comment_create",
      commentId: newer.id,
      commentBody: newer.body,
    });
    expect(result.action).toBe("dispatch_revision");
    expect(result.pmFeedbackCommentId).toBe(newer.id);
  });

  it("ignores harness comments as PM feedback triggers", () => {
    const result = evaluateRevisionReconcile({
      config,
      issue: needsRevisionIssue,
      comments: [handoff],
      trigger: "comment_create",
      commentId: harnessComment.id,
      commentBody: harnessComment.body,
    });
    expect(result.action).toBe("ignore");
    expect(result.reason).toContain("harness orchestrator");
  });

  it("ignores non-latest feedback comment ids", () => {
    const older = {
      id: "older-feedback",
      body: "Older note",
      createdAt: "2026-07-18T18:20:00.000Z",
    };
    const result = evaluateRevisionReconcile({
      config,
      issue: needsRevisionIssue,
      comments: [handoff, older, pmFeedback],
      trigger: "comment_create",
      commentId: older.id,
      commentBody: older.body,
    });
    expect(result.action).toBe("ignore");
    expect(result.reason).toContain("not latest");
  });

  it("treats Needs Revision → Blocked → Needs Revision as eligible when feedback exists", () => {
    const result = evaluateRevisionReconcile({
      config,
      issue: needsRevisionIssue,
      comments: [handoff, pmFeedback],
      trigger: "issue_status",
    });
    expect(result.action).toBe("dispatch_revision");
  });

  it("hashes feedback id into a stable generation", () => {
    const a = revisionGenerationFromPmFeedback(pmFeedback.id);
    const b = revisionGenerationFromPmFeedback(pmFeedback.id);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(1_000_000_000);
  });
});
