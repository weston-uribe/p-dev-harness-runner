import { describe, expect, it } from "vitest";
import { resolveMergeJobRequestId } from "../../src/workflow/job-request/merge-request-id.js";
import { resolveMergeReconcileIdentity } from "../../src/runner/merge-reconcile-identity.js";
import { reconcileWorkflowStateTeamCandidates } from "../../src/runner/workflow-state-team-candidates.js";
import { createEmptyWorkflowState } from "../../src/workflow/state/types.js";
import type { HarnessConfig } from "../../src/config/types.js";
import { evaluateMergeReconcile } from "../../src/runner/merge-reconcile.js";

/**
 * FRE-5 Ready-to-Merge recovery fixture coverage:
 * - pending webhook envelope identity remains distinct from merge reconcile id
 * - authoritative TT state + approved review supply merge identity
 * - merge eligibility holds for PR #50 @ expected head
 * - exactly one deterministic merge request id
 */

const FRE5 = {
  issueKey: "FRE-5",
  teamFre: "8f9c1260-364b-4d3e-9aa2-0391767d5204",
  teamTt: "abe28dd5-59a4-49b6-a867-1301a9ba5185",
  prNumber: 50,
  headSha: "cf71f1481c9b968219c58919839c0885fa2b8cc6",
  decisionIdentity: "d8f219f5c1bccef8bdb0edb2fb2b8470",
  webhookRequestId: "dlv-91472f6570f7b1046d11d3a82f566f53",
  prUrl: "https://github.com/weston-uribe/weston-uribe-portfolio/pull/50",
  targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
};

const config: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  linear: {
    teamKey: "TT",
    eligibleStatuses: {
      planning: ["Ready for Planning"],
      implementation: ["Ready for Build"],
      handoff: ["PR Open"],
      revision: ["Needs Revision"],
      merge: ["Ready to Merge"],
    },
  },
  repos: [
    {
      id: "portfolio",
      linearProjects: ["harness"],
      targetRepo: FRE5.targetRepo,
      baseBranch: "dev",
      productionBranch: "main",
      previewProvider: "vercel",
      linearAssociations: [
        { workspaceId: "ws", teamId: FRE5.teamTt, projectId: "proj-tt" },
        { workspaceId: "ws", teamId: FRE5.teamFre, projectId: "proj-fre" },
      ],
    },
  ],
  allowedTargetRepos: [FRE5.targetRepo],
};

describe("FRE-5 ready-to-merge recovery fixtures", () => {
  it("searches FRE then TT association paths for durable state", () => {
    expect(
      reconcileWorkflowStateTeamCandidates({
        config,
        issueTeamId: FRE5.teamFre,
      }),
    ).toEqual([FRE5.teamFre, FRE5.teamTt]);
  });

  it("builds one merge request id from TT authoritative review + PR #50", () => {
    const ttState = {
      ...createEmptyWorkflowState({
        issueKey: FRE5.issueKey,
        workflowSchemaVersion: "product-development-v2",
      }),
      stateRevision: 7,
      currentPhaseId: "pm_review",
      lastAcceptedReviewDecision: {
        decision: "approved" as const,
        decisionIdentity: FRE5.decisionIdentity,
        phaseId: "code_review",
        acceptedAt: "2026-07-20T19:36:28.223Z",
        reviewedPrNumber: FRE5.prNumber,
        reviewedHeadSha: FRE5.headSha,
        reviewedDiffHash:
          "eae973d70791911cbc46dfa912bf57b6d2159a162697f5617fcbd53f15a2cf05",
        findings: [],
      },
    };

    const comments = [
      {
        id: "handoff",
        body: `<!--
harness-orchestrator-v1
phase: handoff
run_id: code-review-1784576080147
pr_url: ${FRE5.prUrl}
pr_number: ${FRE5.prNumber}
pr_head_sha: ${FRE5.headSha}
-->`,
        createdAt: "2026-07-20T19:36:30.000Z",
      },
    ];

    const identity = resolveMergeReconcileIdentity({
      issue: {
        id: "issue-fre-5",
        identifier: FRE5.issueKey,
        title: "Add Kinterra",
        description: "",
        status: "Ready to Merge",
        projectName: "harness",
        teamName: "FRE",
        teamKey: "FRE",
        teamId: FRE5.teamFre,
        projectId: "proj-fre",
        url: "https://linear.app/example/issue/FRE-5",
      },
      comments,
      orchestratorMarker: config.orchestratorMarker,
      targetRepository: FRE5.targetRepo,
      authoritativeState: ttState,
    });

    expect(identity).not.toBeNull();
    const mergeRequestId = resolveMergeJobRequestId(identity!);
    expect(mergeRequestId).toMatch(/^mrg-[a-f0-9]{32}$/);
    expect(mergeRequestId).not.toBe(FRE5.webhookRequestId);

    const again = resolveMergeJobRequestId(identity!);
    expect(again).toBe(mergeRequestId);
  });

  it("keeps merge eligible for open PR #50 at the reviewed head", () => {
    const comments = [
      {
        id: "handoff",
        body: `<!--
harness-orchestrator-v1
phase: handoff
run_id: code-review-1784576080147
pr_url: ${FRE5.prUrl}
pr_number: ${FRE5.prNumber}
pr_head_sha: ${FRE5.headSha}
-->`,
        createdAt: "2026-07-20T19:36:30.000Z",
      },
    ];
    const result = evaluateMergeReconcile({
      config,
      issue: {
        id: "issue-fre-5",
        identifier: FRE5.issueKey,
        title: "Add Kinterra",
        description: "",
        status: "Ready to Merge",
        projectName: "harness",
        teamName: "FRE",
        teamKey: "FRE",
        teamId: FRE5.teamFre,
        projectId: "proj-fre",
        url: "https://linear.app/example/issue/FRE-5",
      },
      comments,
      trigger: "cli",
      expectedBaseBranch: "dev",
      pullRequest: {
        url: FRE5.prUrl,
        state: "open",
        merged: false,
        baseBranch: "dev",
      },
    });
    expect(result.action).toBe("dispatch_merge");
    expect(result.reason).toBe("eligible_merge");
    expect(result.prUrl).toBe(FRE5.prUrl);
  });

  it("does not treat the stranded webhook envelope as the merge request identity", () => {
    const mergeId = resolveMergeJobRequestId({
      issueKey: FRE5.issueKey,
      targetRepository: FRE5.targetRepo,
      prNumber: FRE5.prNumber,
      reviewedHeadSha: FRE5.headSha,
      approvedReviewDecisionIdentity: FRE5.decisionIdentity,
    });
    expect(FRE5.webhookRequestId.startsWith("dlv-")).toBe(true);
    expect(mergeId.startsWith("mrg-")).toBe(true);
    expect(mergeId).not.toBe(FRE5.webhookRequestId);
  });
});
