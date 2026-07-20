import { describe, expect, it } from "vitest";
import { resolveWorkflowDefinition } from "../../src/workflow/definition/resolve.js";
import { migrateWorkflowConfigSection } from "../../src/config/migrate-workflow-config.js";
import type { HarnessConfig } from "../../src/config/types.js";
import {
  claimAgentRun,
  createEmptyWorkflowState,
  DEFAULT_ACTIVE_RUN_LEASE_TTL_MS,
  InMemoryWorkflowStateStore,
  isActiveRunLeaseExpired,
} from "../../src/workflow/state/index.js";

const baseConfig: HarnessConfig = {
  version: 1,
  repos: [
    {
      id: "primary",
      targetRepo: "https://github.com/acme/app",
      baseBranch: "dev",
    },
  ],
  allowedTargetRepos: ["https://github.com/acme/app"],
};

function definition() {
  return resolveWorkflowDefinition({
    workflowConfig: migrateWorkflowConfigSection(baseConfig),
    effectiveOptionalPhases: { planReview: false, codeReview: true },
  });
}

describe("active run lease recovery", () => {
  it("grants exclusive ownership and blocks a healthy concurrent claim", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "FRE-LEASE-1";
    await store.compareAndSet({
      issueKey,
      expectedRevision: 0,
      next: {
        ...createEmptyWorkflowState({
          issueKey,
          workflowSchemaVersion: "test",
          effectiveOptionalPhases: { planReview: false, codeReview: true },
        }),
        stateRevision: 1,
        currentPhaseId: "code_review",
      },
    });

    const first = await claimAgentRun({
      store,
      issueKey,
      definition: definition(),
      expectedStateRevision: 1,
      currentPhaseId: "code_review",
      runId: "run-a",
      evidence: { linearStatusName: "Code Review" },
      leaseIdentity: "code_review:subject-a",
      subjectIdentity: "subject-a",
      leaseTtlMs: DEFAULT_ACTIVE_RUN_LEASE_TTL_MS,
    });
    expect(first.ok).toBe(true);
    expect(first.state?.activeRunLease?.ownerRunId).toBe("run-a");
    expect(first.state?.activeRunIdentities).toEqual(["code_review:subject-a"]);

    const second = await claimAgentRun({
      store,
      issueKey,
      definition: definition(),
      expectedStateRevision: first.state!.stateRevision,
      currentPhaseId: "code_review",
      runId: "run-b",
      evidence: { linearStatusName: "Code Review" },
      leaseIdentity: "code_review:subject-a",
      subjectIdentity: "subject-a",
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("active_run_conflict");
  });

  it("recovers an expired lease for a retry owner", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "FRE-LEASE-2";
    const expiredAt = new Date(Date.now() - 1_000).toISOString();
    await store.compareAndSet({
      issueKey,
      expectedRevision: 0,
      next: {
        ...createEmptyWorkflowState({
          issueKey,
          workflowSchemaVersion: "test",
          effectiveOptionalPhases: { planReview: false, codeReview: true },
        }),
        stateRevision: 1,
        currentPhaseId: "code_review",
        activeRunIdentities: ["code_review:subject-b"],
        activeRunLease: {
          identity: "code_review:subject-b",
          ownerRunId: "crashed-run",
          phaseId: "code_review",
          subjectIdentity: "subject-b",
          acquiredAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: expiredAt,
          heartbeatAt: expiredAt,
        },
      },
    });

    expect(
      isActiveRunLeaseExpired(
        (
          await store.load(issueKey)
        )?.activeRunLease,
        Date.now(),
      ),
    ).toBe(true);

    const recovered = await claimAgentRun({
      store,
      issueKey,
      definition: definition(),
      expectedStateRevision: 1,
      currentPhaseId: "code_review",
      runId: "run-retry",
      evidence: { linearStatusName: "Code Review" },
      leaseIdentity: "code_review:subject-b",
      subjectIdentity: "subject-b",
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.state?.activeRunLease?.ownerRunId).toBe("run-retry");
  });

  it("allows a new subject claim while another subject is not active", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "FRE-LEASE-3";
    await store.compareAndSet({
      issueKey,
      expectedRevision: 0,
      next: {
        ...createEmptyWorkflowState({
          issueKey,
          workflowSchemaVersion: "test",
          effectiveOptionalPhases: { planReview: false, codeReview: true },
        }),
        stateRevision: 1,
        currentPhaseId: "code_review",
        activeRunIdentities: [],
        activeRunLease: null,
        acceptedReviewSubjects: {
          "subject-old": "decision-old",
        },
      },
    });

    const nextSubject = await claimAgentRun({
      store,
      issueKey,
      definition: definition(),
      expectedStateRevision: 1,
      currentPhaseId: "code_review",
      runId: "run-new-head",
      evidence: { linearStatusName: "Code Review" },
      leaseIdentity: "code_review:subject-new",
      subjectIdentity: "subject-new",
    });
    expect(nextSubject.ok).toBe(true);
    expect(nextSubject.state?.activeRunLease?.subjectIdentity).toBe(
      "subject-new",
    );
  });
});
