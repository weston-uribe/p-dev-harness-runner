import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import type { LinearIssueSnapshot } from "../../src/linear/client.js";
import { evaluateMergeReconcile } from "../../src/runner/merge-reconcile.js";
import { formatMergeComment } from "../../src/linear/comments.js";

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    eligibleStatuses: {
      merge: ["Ready to Merge"],
    },
    transitionalStatuses: {
      readyToMerge: "Ready to Merge",
      mergingInProgress: "Merging",
      mergedToDev: "Merged to Dev",
      mergedDeployed: "Merged / Deployed",
    },
  },
  repos: [],
  allowedTargetRepos: ["https://github.com/o/r"],
};

const prUrl = "https://github.com/o/r/pull/39";

const readyIssue: LinearIssueSnapshot = {
  id: "issue-1",
  identifier: "FRE-3",
  title: "Test",
  description: "",
  status: "Ready to Merge",
  projectName: null,
  teamName: null,
  teamKey: "FRE",
  teamId: "team-1",
  url: null,
};

const revisionMarker = {
  id: "rev-1",
  body: `Revision done\n\n---\nharness-orchestrator-v1\nphase: revision\nrun_id: run-rev\npm_feedback_comment_id: ab390a10-00eb-419d-ab91-0d9d846c85af\npr_url: ${prUrl}\nbranch: cursor/fre-3\ntarget_repo: https://github.com/o/r\n---`,
  createdAt: "2026-07-18T19:00:00.000Z",
};

const handoffMarker = {
  id: "handoff-1",
  body: `Handoff\n\n---\nharness-orchestrator-v1\nphase: handoff\nrun_id: run-handoff\npr_url: ${prUrl}\n---`,
  createdAt: "2026-07-18T18:15:42.000Z",
};

const openPr = {
  url: prUrl,
  state: "open",
  merged: false,
  baseBranch: "dev",
};

describe("evaluateMergeReconcile", () => {
  it("ignores wrong status (Engineering Review)", () => {
    const result = evaluateMergeReconcile({
      config,
      issue: { ...readyIssue, status: "Engineering Review" },
      comments: [revisionMarker],
      trigger: "issue_status",
      expectedBaseBranch: "dev",
      pullRequest: openPr,
    });
    expect(result.action).toBe("ignore");
    expect(result.reason).toContain("wrong_status");
  });

  it("dispatches when Ready to Merge with revision PR marker", () => {
    const result = evaluateMergeReconcile({
      config,
      issue: readyIssue,
      comments: [handoffMarker, revisionMarker],
      trigger: "cli",
      expectedBaseBranch: "dev",
      pullRequest: openPr,
    });
    expect(result).toEqual({
      action: "dispatch_merge",
      prUrl,
      reason: "eligible_merge",
    });
  });

  it("uses revision marker over older handoff for generation identity", () => {
    const otherPr = "https://github.com/o/r/pull/1";
    const result = evaluateMergeReconcile({
      config,
      issue: readyIssue,
      comments: [
        {
          ...handoffMarker,
          body: handoffMarker.body.replace(prUrl, otherPr),
        },
        revisionMarker,
      ],
      trigger: "schedule",
      expectedBaseBranch: "dev",
      pullRequest: openPr,
    });
    expect(result.action).toBe("dispatch_merge");
    expect(result.prUrl).toBe(prUrl);
  });

  it("ignores missing merge source marker", () => {
    const result = evaluateMergeReconcile({
      config,
      issue: readyIssue,
      comments: [],
      trigger: "issue_status",
    });
    expect(result).toEqual({
      action: "ignore",
      prUrl: null,
      reason: "missing_merge_source_marker",
    });
  });

  it("ignores PR base branch mismatch", () => {
    const result = evaluateMergeReconcile({
      config,
      issue: readyIssue,
      comments: [revisionMarker],
      trigger: "cli",
      expectedBaseBranch: "dev",
      pullRequest: { ...openPr, baseBranch: "main" },
    });
    expect(result.action).toBe("ignore");
    expect(result.reason).toContain("pr_base_mismatch");
  });

  it("skips when merge already completed for this PR generation", () => {
    const mergeMarker = {
      id: "merge-1",
      body: formatMergeComment("merged", {
        orchestratorMarker: config.orchestratorMarker,
        phase: "merge",
        runId: "merge-run",
        model: "composer-2.5",
        promptVersion: "merge@1",
        targetRepo: "https://github.com/o/r",
        prUrl,
      }),
      createdAt: "2026-07-18T20:00:00.000Z",
    };
    const result = evaluateMergeReconcile({
      config,
      issue: { ...readyIssue, status: "Merged to Dev" },
      comments: [revisionMarker, mergeMarker],
      trigger: "cli",
      expectedBaseBranch: "dev",
      pullRequest: { ...openPr, state: "closed", merged: true },
    });
    expect(result.action).toBe("skip_duplicate");
  });

  it("does not let a prior revision marker suppress merge", () => {
    const result = evaluateMergeReconcile({
      config,
      issue: readyIssue,
      comments: [revisionMarker],
      trigger: "issue_status",
      expectedBaseBranch: "dev",
      pullRequest: openPr,
    });
    expect(result.action).toBe("dispatch_merge");
  });

  it("allows force while Merging", () => {
    const result = evaluateMergeReconcile({
      config,
      issue: { ...readyIssue, status: "Merging" },
      comments: [revisionMarker],
      trigger: "cli",
      expectedBaseBranch: "dev",
      pullRequest: openPr,
      force: true,
    });
    expect(result.action).toBe("dispatch_merge");
  });

  it("dispatches without live PR when GitHub snapshot unavailable", () => {
    const result = evaluateMergeReconcile({
      config,
      issue: readyIssue,
      comments: [revisionMarker],
      trigger: "schedule",
      expectedBaseBranch: "dev",
      pullRequest: null,
    });
    expect(result.action).toBe("dispatch_merge");
    expect(result.prUrl).toBe(prUrl);
  });
});
