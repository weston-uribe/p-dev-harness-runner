import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateWorkflowReconcileIssue,
} from "../../src/runner/workflow-reconcile.js";
import type { HarnessConfig } from "../../src/config/types.js";
import { createEmptyWorkflowState } from "../../src/workflow/state/types.js";
import { resolveMergeJobRequestId } from "../../src/workflow/job-request/merge-request-id.js";

const mocks = vi.hoisted(() => ({
  fetchLinearIssue: vi.fn(),
  listIssueComments: vi.fn(),
  createWorkflowStateStore: vi.fn(),
  resolveRoute: vi.fn(),
  dispatchMergeReconcileJob: vi.fn(),
  runLinearAssociationGate: vi.fn(() => ({ ok: true })),
  listIncompleteSideEffects: vi.fn(() => []),
}));

vi.mock("../../src/linear/client.js", () => ({
  fetchLinearIssue: mocks.fetchLinearIssue,
}));

vi.mock("../../src/linear/writer.js", () => ({
  createLinearClient: vi.fn(() => ({})),
  listIssueComments: mocks.listIssueComments,
  transitionIssueStatus: vi.fn(),
}));

vi.mock("../../src/config/linear-association-gate.js", () => ({
  runLinearAssociationGate: mocks.runLinearAssociationGate,
}));

vi.mock("../../src/workflow/state/factory.js", () => ({
  createWorkflowStateStore: mocks.createWorkflowStateStore,
  resolveWorkflowStateStoreMode: () => "file",
}));

vi.mock("../../src/workflow/state/side-effects.js", () => ({
  listIncompleteSideEffects: mocks.listIncompleteSideEffects,
}));

vi.mock("../../src/runner/resolve-route.js", () => ({
  resolveRoute: mocks.resolveRoute,
}));

vi.mock("../../src/workflow/job-request/dispatch-merge-reconcile.js", () => ({
  dispatchMergeReconcileJob: mocks.dispatchMergeReconcileJob,
}));

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
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      baseBranch: "dev",
      productionBranch: "main",
      previewProvider: "vercel",
      linearAssociations: [
        {
          workspaceId: "ws",
          teamId: "team-tt",
          teamKey: "TT",
          projectId: "proj-tt",
          projectName: "Test Project",
        },
        {
          workspaceId: "ws",
          teamId: "team-fre",
          teamKey: "FRE",
          projectId: "proj-fre",
          projectName: "harness",
        },
      ],
    },
  ],
  allowedTargetRepos: [
    "https://github.com/weston-uribe/weston-uribe-portfolio",
  ],
};

const handoffBody = `<!-- p-dev-pm-handoff:9a9b9eb3296c6b7be05c421838da2439 -->
# Comment from harness
**Phase:** PM handoff
- [Pull request](https://github.com/weston-uribe/weston-uribe-portfolio/pull/50)
<!--
harness-orchestrator-v1
phase: handoff
run_id: code-review-1784576080147
pr_url: https://github.com/weston-uribe/weston-uribe-portfolio/pull/50
pr_number: 50
pr_head_sha: cf71f1481c9b968219c58919839c0885fa2b8cc6
-->`;

describe("workflow reconcile merge opaque dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runLinearAssociationGate.mockReturnValue({ ok: true });
    mocks.listIncompleteSideEffects.mockReturnValue([]);
    mocks.fetchLinearIssue.mockResolvedValue({
      id: "issue-fre-5",
      identifier: "FRE-5",
      title: "Add Kinterra",
      description: `## Target repo

weston-uribe/weston-uribe-portfolio

## Task

Add Kinterra page

## Acceptance criteria

- [ ] Done

## Out of scope

- [ ] N/A
`,
      status: "Ready to Merge",
      projectName: "harness",
      teamName: "FRE",
      teamKey: "FRE",
      teamId: "team-fre",
      projectId: "proj-fre",
      url: "https://linear.app/example/issue/FRE-5",
    });
    mocks.listIssueComments.mockResolvedValue([
      {
        id: "handoff",
        body: handoffBody,
        createdAt: "2026-07-20T19:36:30.000Z",
      },
    ]);
    const state = {
      ...createEmptyWorkflowState({
        issueKey: "FRE-5",
        workflowSchemaVersion: "product-development-v2",
      }),
      stateRevision: 7,
      currentPhaseId: "pm_review",
      lastAcceptedReviewDecision: {
        decision: "approved" as const,
        decisionIdentity: "d8f219f5c1bccef8bdb0edb2fb2b8470",
        phaseId: "code_review",
        acceptedAt: "2026-07-20T19:36:28.223Z",
        reviewedPrNumber: 50,
        reviewedHeadSha: "cf71f1481c9b968219c58919839c0885fa2b8cc6",
        reviewedDiffHash: "eae973d70791911cbc46dfa912bf57b6d2159a162697f5617fcbd53f15a2cf05",
        findings: [],
      },
      latestImplementationArtifact: {
        implementationGenerationId: "8d3bb8dd-8aac-426c-a036-9febc79abf9a",
        targetRepository: "https://github.com/weston-uribe/weston-uribe-portfolio",
        prNumber: 50,
        prUrl: "https://github.com/weston-uribe/weston-uribe-portfolio/pull/50",
        headSha: "cf71f1481c9b968219c58919839c0885fa2b8cc6",
        baseSha: "bd3f39261731969117bcbaa7327983d8ee6ce669",
        diffHash: "eae973d70791911cbc46dfa912bf57b6d2159a162697f5617fcbd53f15a2cf05",
        builderRunId: "run",
        acceptanceEvidenceId: null,
        testEvidenceId: null,
        workflowStateRevision: 1,
        createdAt: "2026-07-20T18:41:17.263Z",
        supersedesImplementationGenerationId: null,
        causedByReviewDecisionIdentity: null,
      },
    };
    mocks.createWorkflowStateStore.mockResolvedValue({
      load: async () => state,
    });
    mocks.resolveRoute.mockResolvedValue({
      issueKey: "FRE-5",
      phase: "merge",
      repoConfigId: "portfolio",
      baseBranch: "dev",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      linearStatus: "Ready to Merge",
      mergeConcurrencyGroup: "portfolio-dev",
      shouldRun: true,
      reconcileReason: "eligible_merge",
      mergePrUrl: "https://github.com/weston-uribe/weston-uribe-portfolio/pull/50",
      workflowStateRevision: 7,
    });
  });

  it("dispatches a deterministic merge request once across two reconciles", async () => {
    const requestId = resolveMergeJobRequestId({
      issueKey: "FRE-5",
      targetRepository: "https://github.com/weston-uribe/weston-uribe-portfolio",
      prNumber: 50,
      reviewedHeadSha: "cf71f1481c9b968219c58919839c0885fa2b8cc6",
      approvedReviewDecisionIdentity: "d8f219f5c1bccef8bdb0edb2fb2b8470",
    });
    mocks.dispatchMergeReconcileJob
      .mockResolvedValueOnce({
        requestId,
        outcome: "dispatched",
        dispatched: true,
        record: { requestId },
      })
      .mockResolvedValueOnce({
        requestId,
        outcome: "already_dispatched",
        dispatched: false,
        record: { requestId },
      });

    const first = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-5",
      linearApiKey: "lin",
      dispatch: true,
    });
    const second = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-5",
      linearApiKey: "lin",
      dispatch: true,
    });

    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(second.reason).toBe("merge_request_already_dispatched");
    expect(mocks.dispatchMergeReconcileJob).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchMergeReconcileJob.mock.calls[0]![0]).toMatchObject({
      issueKey: "FRE-5",
      prNumber: 50,
      reviewedHeadSha: "cf71f1481c9b968219c58919839c0885fa2b8cc6",
      approvedReviewDecisionIdentity: "d8f219f5c1bccef8bdb0edb2fb2b8470",
    });
    expect(mocks.dispatchMergeReconcileJob.mock.calls[0]![0].issueKey).toBe(
      mocks.dispatchMergeReconcileJob.mock.calls[1]![0].issueKey,
    );
  });

  it("no-ops when merge request is already claimed", async () => {
    mocks.dispatchMergeReconcileJob.mockResolvedValue({
      requestId: "mrg-abc",
      outcome: "already_claimed",
      dispatched: false,
      record: null,
    });
    const result = await evaluateWorkflowReconcileIssue({
      config,
      configPath: "/tmp/harness.config.json",
      issueKey: "FRE-5",
      linearApiKey: "lin",
      dispatch: true,
    });
    expect(result.action).toBe("noop");
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("merge_request_already_claimed");
  });
});
