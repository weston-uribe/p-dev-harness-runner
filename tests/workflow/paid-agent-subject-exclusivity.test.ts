/**
 * Evaluation invariant: at most one logical paid Cursor agent per immutable
 * phase subject / execution identity — not per phase name.
 *
 * Same subject → no second claim. New head / diff / cycle → new subject may claim.
 */
import { describe, expect, it } from "vitest";
import { resolveWorkflowDefinition } from "../../src/workflow/definition/resolve.js";
import { migrateWorkflowConfigSection } from "../../src/config/migrate-workflow-config.js";
import type { HarnessConfig } from "../../src/config/types.js";
import { buildCodeReviewSubjectIdentity } from "../../src/workflow/subject-identities.js";
import {
  claimAgentRun,
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
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

const subjectBase = {
  issueKey: "WES-SUBJECT",
  prNumber: 42,
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  diffHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  reviewCycle: 0,
};

describe("paid agent subject exclusivity", () => {
  it("derives distinct subjects when headSha, diffHash, or reviewCycle changes", () => {
    const a = buildCodeReviewSubjectIdentity(subjectBase);
    const newHead = buildCodeReviewSubjectIdentity({
      ...subjectBase,
      headSha: "cccccccccccccccccccccccccccccccccccccccc",
    });
    const newDiff = buildCodeReviewSubjectIdentity({
      ...subjectBase,
      diffHash:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    });
    const newCycle = buildCodeReviewSubjectIdentity({
      ...subjectBase,
      reviewCycle: 1,
    });

    expect(a).not.toBe(newHead);
    expect(a).not.toBe(newDiff);
    expect(a).not.toBe(newCycle);
    expect(
      buildCodeReviewSubjectIdentity(subjectBase),
    ).toBe(a);
  });

  it("blocks a second paid claim for the same immutable subject while lease is live", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "WES-SUBJECT";
    const subject = buildCodeReviewSubjectIdentity(subjectBase);
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
      runId: "paid-run-1",
      evidence: { linearStatusName: "Code Review" },
      leaseIdentity: `code_review:${subject}`,
      subjectIdentity: subject,
    });
    expect(first.ok).toBe(true);

    const duplicate = await claimAgentRun({
      store,
      issueKey,
      definition: definition(),
      expectedStateRevision: first.state!.stateRevision,
      currentPhaseId: "code_review",
      runId: "paid-run-2",
      evidence: { linearStatusName: "Code Review" },
      leaseIdentity: `code_review:${subject}`,
      subjectIdentity: subject,
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.reason).toBe("active_run_conflict");
  });

  it("allows a new paid claim when the subject changes (new head)", async () => {
    const store = new InMemoryWorkflowStateStore();
    const issueKey = "WES-SUBJECT-HEAD";
    const subjectA = buildCodeReviewSubjectIdentity(subjectBase);
    const subjectB = buildCodeReviewSubjectIdentity({
      ...subjectBase,
      headSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });

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
        // Prior subject completed; lease cleared — new head may claim.
        activeRunIdentities: [],
        activeRunLease: null,
        acceptedReviewSubjects: {
          [subjectA]: "decision-a",
        },
      },
    });

    const next = await claimAgentRun({
      store,
      issueKey,
      definition: definition(),
      expectedStateRevision: 1,
      currentPhaseId: "code_review",
      runId: "paid-run-new-head",
      evidence: { linearStatusName: "Code Review" },
      leaseIdentity: `code_review:${subjectB}`,
      subjectIdentity: subjectB,
    });
    expect(next.ok).toBe(true);
    expect(next.state?.activeRunLease?.subjectIdentity).toBe(subjectB);
    expect(subjectB).not.toBe(subjectA);
  });
});
