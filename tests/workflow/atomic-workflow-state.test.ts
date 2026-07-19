import { describe, expect, it } from "vitest";
import { resolveWorkflowDefinition } from "../../src/workflow/definition/index.js";
import {
  applyWorkflowTransition,
  claimAgentRun,
  createEmptyWorkflowState,
  InMemoryWorkflowStateStore,
  toSnapshotRef,
} from "../../src/workflow/state/index.js";
import type { ReviewOutcome } from "../../src/workflow/review-contracts.js";

const definition = resolveWorkflowDefinition({
  workflowConfig: {
    optionalPhases: { planReview: true, codeReview: true },
    cycleLimits: { planReview: 3, codeReview: 3 },
  },
});

function review(
  decision: ReviewOutcome["decision"],
  identity: string,
): ReviewOutcome {
  return {
    decision,
    summary: "test",
    findings: [],
    decisionIdentity: identity,
    generationId: `gen-${identity}`,
  };
}

describe("atomic workflow state", () => {
  it("two concurrent identical transitions: one accept, counter +1 once", async () => {
    const store = new InMemoryWorkflowStateStore();
    store.seed(
      createEmptyWorkflowState({
        issueKey: "WES-1",
        workflowSchemaVersion: definition.schemaVersion,
        enabledOptionalPhases: { planReview: true, codeReview: true },
      }),
    );
    // Advance to plan_review at revision 1
    const setup = await applyWorkflowTransition({
      store,
      issueKey: "WES-1",
      definition,
      expectedStateRevision: 0,
      currentPhaseId: "planning",
      outcome: {
        kind: "success",
        phaseId: "planning",
        attemptIdentity: "plan-done",
      },
      evidence: { linearStatusName: "Planning" },
    });
    expect(setup.ok).toBe(true);
    expect(setup.state?.currentPhaseId).toBe("plan_review");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    store.beforeWrite = async () => {
      entered += 1;
      if (entered === 1) {
        await gate;
      }
    };

    const a = applyWorkflowTransition({
      store,
      issueKey: "WES-1",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "plan_review",
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "same-attempt",
        review: review("needs_revision", "dec-same"),
      },
      evidence: { linearStatusName: "Plan Review" },
    });

    // Let first writer enter beforeWrite, then start second with same attempt.
    await new Promise((r) => setTimeout(r, 5));
    store.beforeWrite = undefined;
    const b = applyWorkflowTransition({
      store,
      issueKey: "WES-1",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "plan_review",
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "same-attempt",
        review: review("needs_revision", "dec-same"),
      },
      evidence: { linearStatusName: "Plan Review" },
    });

    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok || rb.ok).toBe(true);
    const final = await store.load("WES-1");
    expect(final?.cycleCounters.plan_review_cycles).toBe(1);
    expect(final?.stateRevision).toBe(2);
  });

  it("two conflicting review decisions: exactly one accepted", async () => {
    const store = new InMemoryWorkflowStateStore();
    const seeded = createEmptyWorkflowState({
      issueKey: "WES-2",
      workflowSchemaVersion: definition.schemaVersion,
    });
    seeded.stateRevision = 1;
    seeded.currentPhaseId = "plan_review";
    store.seed(seeded);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    store.beforeWrite = async () => {
      entered += 1;
      if (entered === 1) await gate;
    };

    const approved = applyWorkflowTransition({
      store,
      issueKey: "WES-2",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "plan_review",
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "a",
        review: review("approved", "dec-a"),
      },
      evidence: { linearStatusName: "Plan Review" },
    });
    await new Promise((r) => setTimeout(r, 5));
    store.beforeWrite = undefined;
    const revised = applyWorkflowTransition({
      store,
      issueKey: "WES-2",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "plan_review",
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "b",
        review: review("needs_revision", "dec-b"),
      },
      evidence: { linearStatusName: "Plan Review" },
    });
    release();
    const [r1, r2] = await Promise.all([approved, revised]);
    const accepted = [r1, r2].filter((r) => r.ok && r.reason !== "duplicate_transition");
    expect(accepted.length).toBe(1);
    const final = await store.load("WES-2");
    expect(final?.stateRevision).toBe(2);
    expect(final?.lastAcceptedReviewDecision?.decisionIdentity).toMatch(/^dec-/);
  });

  it("rejects stale expected state revision", async () => {
    const store = new InMemoryWorkflowStateStore();
    const seeded = createEmptyWorkflowState({
      issueKey: "WES-3",
      workflowSchemaVersion: definition.schemaVersion,
    });
    seeded.stateRevision = 5;
    seeded.currentPhaseId = "planning";
    store.seed(seeded);

    const result = await applyWorkflowTransition({
      store,
      issueKey: "WES-3",
      definition,
      expectedStateRevision: 2,
      currentPhaseId: "planning",
      outcome: {
        kind: "success",
        phaseId: "planning",
        attemptIdentity: "stale",
      },
      evidence: { linearStatusName: "Planning" },
      maxRetries: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stale_state|conflict_exhausted/);
    expect((await store.load("WES-3"))?.stateRevision).toBe(5);
  });

  it("reconcile racing with webhook: one eligible agent start", async () => {
    const store = new InMemoryWorkflowStateStore();
    const seeded = createEmptyWorkflowState({
      issueKey: "WES-4",
      workflowSchemaVersion: definition.schemaVersion,
    });
    seeded.stateRevision = 1;
    seeded.currentPhaseId = "planning_dispatch";
    store.seed(seeded);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    store.beforeWrite = async () => {
      entered += 1;
      if (entered === 1) await gate;
    };

    const webhook = claimAgentRun({
      store,
      issueKey: "WES-4",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "planning_dispatch",
      runId: "run-webhook",
      evidence: { linearStatusName: "Ready for Planning" },
    });
    await new Promise((r) => setTimeout(r, 5));
    store.beforeWrite = undefined;
    const reconcile = claimAgentRun({
      store,
      issueKey: "WES-4",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "planning_dispatch",
      runId: "run-reconcile",
      evidence: { linearStatusName: "Ready for Planning" },
    });
    release();
    const [w, r] = await Promise.all([webhook, reconcile]);
    const wins = [w, r].filter((x) => x.ok);
    expect(wins.length).toBe(1);
    const final = await store.load("WES-4");
    expect(final?.activeRunIdentities).toHaveLength(1);
  });

  it("counter increment racing with duplicate delivery does not double-count", async () => {
    const store = new InMemoryWorkflowStateStore();
    const seeded = createEmptyWorkflowState({
      issueKey: "WES-5",
      workflowSchemaVersion: definition.schemaVersion,
    });
    seeded.stateRevision = 1;
    seeded.currentPhaseId = "code_review";
    store.seed(seeded);

    const first = await applyWorkflowTransition({
      store,
      issueKey: "WES-5",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "code_review",
      outcome: {
        kind: "review",
        phaseId: "code_review",
        attemptIdentity: "delivery-1",
        review: review("needs_revision", "dec-code-1"),
      },
      evidence: { linearStatusName: "Code Review" },
    });
    expect(first.ok).toBe(true);

    const duplicate = await applyWorkflowTransition({
      store,
      issueKey: "WES-5",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "code_review",
      outcome: {
        kind: "review",
        phaseId: "code_review",
        attemptIdentity: "delivery-1",
        review: review("needs_revision", "dec-code-1"),
      },
      evidence: { linearStatusName: "Code Review" },
      maxRetries: 2,
    });
    expect(duplicate.ok).toBe(true);
    expect(duplicate.reason).toBe("duplicate_transition");
    const final = await store.load("WES-5");
    expect(final?.cycleCounters.code_review_cycles).toBe(1);
  });

  it("later successful state is not overwritten by an older writer", async () => {
    const store = new InMemoryWorkflowStateStore();
    const seeded = createEmptyWorkflowState({
      issueKey: "WES-6",
      workflowSchemaVersion: definition.schemaVersion,
    });
    seeded.stateRevision = 1;
    seeded.currentPhaseId = "plan_review";
    store.seed(seeded);

    const newer = await applyWorkflowTransition({
      store,
      issueKey: "WES-6",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "plan_review",
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "newer",
        review: review("approved", "dec-new"),
      },
      evidence: { linearStatusName: "Plan Review" },
    });
    expect(newer.ok).toBe(true);
    expect(newer.state?.stateRevision).toBe(2);

    const older = await applyWorkflowTransition({
      store,
      issueKey: "WES-6",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "plan_review",
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "older",
        review: review("needs_revision", "dec-old"),
      },
      evidence: { linearStatusName: "Plan Review" },
      maxRetries: 1,
    });
    expect(older.ok).toBe(false);
    const final = await store.load("WES-6");
    expect(final?.lastAcceptedReviewDecision?.decisionIdentity).toBe("dec-new");
    expect(final?.currentPhaseId).toBe("implementation_dispatch");
  });

  it("recovery uses authoritative state when snapshot disagrees", async () => {
    const store = new InMemoryWorkflowStateStore();
    const seeded = createEmptyWorkflowState({
      issueKey: "WES-7",
      workflowSchemaVersion: definition.schemaVersion,
    });
    seeded.stateRevision = 4;
    seeded.currentPhaseId = "pm_review";
    seeded.cycleCounters.code_review_cycles = 2;
    seeded.lastTransitionIdentity = "success:handoff:h1";
    store.seed(seeded);

    const authoritative = await store.load("WES-7");
    expect(authoritative).not.toBeNull();
    const staleSnapshot = {
      workflowStateRevision: 1,
      lastTransitionIdentity: "success:planning:old",
      currentPhaseId: "planning",
    };
    // Disagreement: snapshot claims planning@1; authority says pm_review@4
    expect(staleSnapshot.workflowStateRevision).not.toBe(
      authoritative!.stateRevision,
    );
    const ref = toSnapshotRef(authoritative!);
    expect(ref.stateRevision).toBe(4);
    expect(ref.lastTransitionIdentity).toBe("success:handoff:h1");

    // Eligibility/recovery must use authoritative revision, not snapshot.
    const result = await applyWorkflowTransition({
      store,
      issueKey: "WES-7",
      definition: resolveWorkflowDefinition(),
      expectedStateRevision: authoritative!.stateRevision,
      currentPhaseId: authoritative!.currentPhaseId!,
      outcome: {
        kind: "human",
        phaseId: "pm_review",
        humanDecisionId: "needs_revision",
        attemptIdentity: "pm-recover",
      },
      evidence: { linearStatusName: "PM Review" },
    });
    expect(result.ok).toBe(true);
    expect(result.state?.currentPhaseId).toBe("revision_dispatch");
    expect(result.state?.stateRevision).toBe(5);
  });

  it("rejects restoring a superseded generation", async () => {
    const store = new InMemoryWorkflowStateStore();
    const seeded = createEmptyWorkflowState({
      issueKey: "WES-8",
      workflowSchemaVersion: definition.schemaVersion,
    });
    seeded.stateRevision = 1;
    seeded.currentPhaseId = "plan_review";
    seeded.supersededGenerationIdentities = ["gen-old"];
    store.seed(seeded);

    const result = await applyWorkflowTransition({
      store,
      issueKey: "WES-8",
      definition,
      expectedStateRevision: 1,
      currentPhaseId: "plan_review",
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "stale-gen",
        generationId: "gen-old",
        review: {
          ...review("approved", "dec-stale-gen"),
          generationId: "gen-old",
        },
      },
      evidence: { linearStatusName: "Plan Review" },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("superseded_generation");
  });
});
