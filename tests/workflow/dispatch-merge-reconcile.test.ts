import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMergeReconcileJob } from "../../src/workflow/job-request/dispatch-merge-reconcile.js";
import { resolveMergeJobRequestId } from "../../src/workflow/job-request/merge-request-id.js";
import type { JobRequestRecord } from "../../src/workflow/job-request/types.js";
import { JOB_REQUEST_KIND, JOB_REQUEST_SCHEMA_VERSION } from "../../src/workflow/job-request/types.js";

const storeState = vi.hoisted(() => ({
  records: new Map<string, JobRequestRecord>(),
  dispatchCalls: 0,
}));

vi.mock("../../src/public-execution/runtime-repos.js", () => ({
  resolveStateGithubToken: () => "state-token",
  resolveDispatchGithubToken: () => "dispatch-token",
  resolveJobRequestRepository: () => ({ owner: "o", repo: "state" }),
  resolveExecutionRepository: () => ({ owner: "o", repo: "runner" }),
  resolveWorkflowStateBranch: () => "p-dev-runtime-state",
}));

vi.mock("../../src/webhook/dispatch-github.js", () => ({
  getDispatchEventType: () => "linear_issue_status_changed",
  getDispatchRepository: () => "o/runner",
  dispatchRepositoryEvent: vi.fn(async () => {
    storeState.dispatchCalls += 1;
  }),
}));

vi.mock("../../src/workflow/job-request/store.js", () => {
  class GithubJobRequestStore {
    async ensureBranch() {}
    async load(requestId: string) {
      const hit = storeState.records.get(requestId);
      return hit ? structuredClone(hit) : null;
    }
    async create(record: JobRequestRecord) {
      if (storeState.records.has(record.requestId)) {
        const { JobRequestStoreError } = await import(
          "../../src/workflow/job-request/store.js"
        );
        // Use a plain error with code for the catch path in production code.
        const err = new Error("exists") as Error & { code: string };
        err.code = "already_exists";
        throw Object.assign(err, { name: "JobRequestStoreError" });
      }
      storeState.records.set(record.requestId, structuredClone(record));
      return structuredClone(record);
    }
    async compareAndSet(input: {
      requestId: string;
      expectedRevision: number;
      next: JobRequestRecord;
    }) {
      const current = storeState.records.get(input.requestId);
      if (!current || current.revision !== input.expectedRevision) return null;
      if (input.next.revision !== input.expectedRevision + 1) return null;
      storeState.records.set(input.requestId, structuredClone(input.next));
      return structuredClone(input.next);
    }
  }
  class JobRequestStoreError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
      this.name = "JobRequestStoreError";
    }
  }
  return { GithubJobRequestStore, JobRequestStoreError };
});

function seed(record: JobRequestRecord) {
  storeState.records.set(record.requestId, structuredClone(record));
}

const identity = {
  issueKey: "FRE-5",
  targetRepository: "https://github.com/weston-uribe/weston-uribe-portfolio",
  prNumber: 50,
  prUrl: "https://github.com/weston-uribe/weston-uribe-portfolio/pull/50",
  reviewedHeadSha: "cf71f1481c9b968219c58919839c0885fa2b8cc6",
  approvedReviewDecisionIdentity: "d8f219f5c1bccef8bdb0edb2fb2b8470",
};

describe("dispatchMergeReconcileJob", () => {
  beforeEach(() => {
    storeState.records.clear();
    storeState.dispatchCalls = 0;
  });

  it("creates and dispatches once; second call is already_dispatched", async () => {
    const first = await dispatchMergeReconcileJob(identity);
    const second = await dispatchMergeReconcileJob(identity);
    expect(first.outcome).toBe("dispatched");
    expect(first.dispatched).toBe(true);
    expect(second.outcome).toBe("already_dispatched");
    expect(second.dispatched).toBe(false);
    expect(storeState.dispatchCalls).toBe(1);
    expect(first.requestId).toBe(resolveMergeJobRequestId(identity));
  });

  it("skips when pending request already attempted dispatch without confirm", async () => {
    const requestId = resolveMergeJobRequestId(identity);
    seed({
      kind: JOB_REQUEST_KIND,
      schemaVersion: JOB_REQUEST_SCHEMA_VERSION,
      requestId,
      issueKey: "FRE-5",
      phase: "merge",
      triggerSource: "merge_reconcile",
      linearDeliveryId: `merge-subject:${requestId}`,
      force: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      state: "pending",
      claimIdentity: null,
      completionState: null,
      dedupeIdentity: "x",
      revision: 1,
      dispatch: {
        attemptedAt: new Date().toISOString(),
        confirmedAt: null,
        failureCategory: null,
      },
    });
    const result = await dispatchMergeReconcileJob(identity);
    expect(result.outcome).toBe("already_dispatched");
    expect(storeState.dispatchCalls).toBe(0);
  });

  it("skips claimed, completed, and merged PR", async () => {
    const requestId = resolveMergeJobRequestId(identity);
    seed({
      kind: JOB_REQUEST_KIND,
      schemaVersion: JOB_REQUEST_SCHEMA_VERSION,
      requestId,
      issueKey: "FRE-5",
      phase: "merge",
      triggerSource: "merge_reconcile",
      linearDeliveryId: null,
      force: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      state: "claimed",
      claimIdentity: "run-1",
      completionState: null,
      dedupeIdentity: "x",
      revision: 2,
    });
    expect((await dispatchMergeReconcileJob(identity)).outcome).toBe(
      "already_claimed",
    );

    storeState.records.clear();
    seed({
      kind: JOB_REQUEST_KIND,
      schemaVersion: JOB_REQUEST_SCHEMA_VERSION,
      requestId,
      issueKey: "FRE-5",
      phase: "merge",
      triggerSource: "merge_reconcile",
      linearDeliveryId: null,
      force: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      state: "completed",
      claimIdentity: "run-1",
      completionState: "verified_complete",
      dedupeIdentity: "x",
      revision: 3,
    });
    expect((await dispatchMergeReconcileJob(identity)).outcome).toBe(
      "already_completed",
    );

    storeState.records.clear();
    expect(
      (
        await dispatchMergeReconcileJob({
          ...identity,
          pullRequestMerged: true,
        })
      ).outcome,
    ).toBe("pr_already_merged");
    expect(storeState.dispatchCalls).toBe(0);
  });
});
