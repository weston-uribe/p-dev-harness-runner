import { describe, expect, it } from "vitest";
import { resolveWorkflowDefinition } from "../../src/workflow/definition/index.js";
import {
  evaluateTransition,
  type TransitionEngineInput,
} from "../../src/workflow/transition-engine.js";
import type { ReviewOutcome } from "../../src/workflow/review-contracts.js";

function baseInput(
  overrides: Partial<TransitionEngineInput> &
    Pick<TransitionEngineInput, "currentPhaseId" | "outcome">,
): TransitionEngineInput {
  return {
    definition: resolveWorkflowDefinition({
      baseBranch: "dev",
      productionBranch: "main",
    }),
    cycleCounters: { plan_review_cycles: 0, code_review_cycles: 0 },
    evidence: {
      linearStatusName: "Planning",
    },
    ...overrides,
  };
}

describe("transition engine — no-review parity", () => {
  it.each([
    {
      name: "planning success bypasses to Ready for Build",
      currentPhaseId: "planning",
      outcome: {
        kind: "success" as const,
        phaseId: "planning",
        attemptIdentity: "plan-1",
      },
      nextStatusName: "Ready for Build",
      reason: "optional_phase_disabled",
    },
    {
      name: "implementation success to handoff",
      currentPhaseId: "implementation",
      outcome: {
        kind: "success" as const,
        phaseId: "implementation",
        attemptIdentity: "impl-1",
      },
      nextStatusName: "PR Open",
      reason: "default_next",
    },
    {
      name: "handoff success bypasses to PM Review",
      currentPhaseId: "handoff",
      outcome: {
        kind: "success" as const,
        phaseId: "handoff",
        attemptIdentity: "handoff-1",
      },
      nextStatusName: "PM Review",
      reason: "optional_phase_disabled",
    },
    {
      name: "revision success bypasses to PM Review",
      currentPhaseId: "revision",
      outcome: {
        kind: "success" as const,
        phaseId: "revision",
        attemptIdentity: "rev-1",
      },
      nextStatusName: "PM Review",
      reason: "optional_phase_disabled",
    },
    {
      name: "merge success to Merged to Dev",
      currentPhaseId: "merge",
      outcome: {
        kind: "success" as const,
        phaseId: "merge",
        attemptIdentity: "merge-1",
      },
      nextStatusName: "Merged to Dev",
      reason: "default_next",
    },
  ])("$name", ({ currentPhaseId, outcome, nextStatusName, reason }) => {
    const result = evaluateTransition(
      baseInput({ currentPhaseId, outcome }),
    );
    expect(result.accepted).toBe(true);
    expect(result.nextStatusName).toBe(nextStatusName);
    expect(result.reason).toBe(reason);
    expect(result.bypass?.createTrace ?? false).toBe(false);
  });

  it("PM revision human path: PM Review → Needs Revision", () => {
    const result = evaluateTransition(
      baseInput({
        currentPhaseId: "pm_review",
        outcome: {
          kind: "human",
          phaseId: "pm_review",
          humanDecisionId: "needs_revision",
          attemptIdentity: "pm-1",
        },
        evidence: { linearStatusName: "PM Review" },
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.nextStatusName).toBe("Needs Revision");
  });

  it("claim Ready for Planning → Planning", () => {
    const result = evaluateTransition(
      baseInput({
        currentPhaseId: "planning_dispatch",
        outcome: {
          kind: "claim",
          phaseId: "planning_dispatch",
          attemptIdentity: "claim-1",
        },
        evidence: { linearStatusName: "Ready for Planning" },
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.nextStatusName).toBe("Planning");
    expect(result.requiredAction).toBe("run_agent");
  });

  it("failure transitions to Blocked", () => {
    const result = evaluateTransition(
      baseInput({
        currentPhaseId: "implementation",
        outcome: {
          kind: "failure",
          phaseId: "implementation",
          attemptIdentity: "fail-1",
        },
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.nextStatusName).toBe("Blocked");
  });

  it("infra retry does not increment review counters", () => {
    const result = evaluateTransition(
      baseInput({
        currentPhaseId: "plan_review",
        cycleCounters: { plan_review_cycles: 2, code_review_cycles: 0 },
        outcome: {
          kind: "infra_retry",
          phaseId: "plan_review",
          attemptIdentity: "infra-1",
        },
      }),
    );
    expect(result.updatedCounters.plan_review_cycles).toBe(2);
    expect(result.reason).toBe("infra_retry_no_counter_increment");
  });
});

describe("transition engine — optional phases", () => {
  it("routes planning to plan_review when enabled", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { planReview: true } },
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "planning",
      cycleCounters: {},
      evidence: { linearStatusName: "Planning" },
      outcome: {
        kind: "success",
        phaseId: "planning",
        attemptIdentity: "plan-enabled",
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.nextStatusName).toBe("Plan Review");
    expect(result.bypass).toBeNull();
  });

  it("bypassed phase emits no fake agent or trace", () => {
    const result = evaluateTransition(
      baseInput({
        currentPhaseId: "planning",
        outcome: {
          kind: "success",
          phaseId: "planning",
          attemptIdentity: "bypass-1",
        },
      }),
    );
    expect(result.bypass).toMatchObject({
      event: "phase_bypassed",
      createTrace: false,
      createAgentRun: false,
      scored: false,
    });
    expect(result.requiredAction).toBe("bypass");
  });
});

describe("transition engine — review loops", () => {
  const reviewOutcome = (
    decision: ReviewOutcome["decision"],
    identity: string,
  ): ReviewOutcome => ({
    decision,
    summary: "test",
    findings: [],
    decisionIdentity: identity,
    generationId: `gen-${identity}`,
  });

  it("approves plan review to Ready for Build", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { planReview: true } },
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "plan_review",
      cycleCounters: { plan_review_cycles: 0 },
      evidence: { linearStatusName: "Plan Review" },
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "r1",
        review: reviewOutcome("approved", "dec-1"),
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.nextStatusName).toBe("Ready for Build");
    expect(result.updatedCounters.plan_review_cycles).toBe(0);
  });

  it("needs_revision increments independent counters", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: {
        optionalPhases: { planReview: true, codeReview: true },
        cycleLimits: { planReview: 3, codeReview: 3 },
      },
    });
    const plan = evaluateTransition({
      definition,
      currentPhaseId: "plan_review",
      cycleCounters: { plan_review_cycles: 0, code_review_cycles: 2 },
      evidence: { linearStatusName: "Plan Review" },
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "r2",
        review: reviewOutcome("needs_revision", "dec-plan"),
      },
    });
    expect(plan.updatedCounters.plan_review_cycles).toBe(1);
    expect(plan.updatedCounters.code_review_cycles).toBe(2);
    expect(plan.nextStatusName).toBe("Ready for Planning");
  });

  it("escalates at maximum cycles without auto-approve", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: {
        optionalPhases: { codeReview: true },
        cycleLimits: { codeReview: 2 },
      },
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "code_review",
      cycleCounters: { code_review_cycles: 2 },
      evidence: { linearStatusName: "Code Review" },
      outcome: {
        kind: "review",
        phaseId: "code_review",
        attemptIdentity: "r3",
        review: reviewOutcome("needs_revision", "dec-max"),
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("cycle_limit_reached");
    expect(result.updatedCounters.code_review_cycles).toBe(2);
  });

  it("rejects duplicate decision", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { planReview: true } },
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "plan_review",
      cycleCounters: {},
      evidence: {
        linearStatusName: "Plan Review",
        lastAcceptedDecisionIdentity: "dec-dup",
      },
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "r4",
        review: reviewOutcome("approved", "dec-dup"),
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectReason).toBe("duplicate_decision");
  });

  it("rejects stale generation", () => {
    const definition = resolveWorkflowDefinition({
      workflowConfig: { optionalPhases: { planReview: true } },
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "plan_review",
      cycleCounters: {},
      evidence: {
        linearStatusName: "Plan Review",
        supersededGenerationIds: ["gen-old"],
      },
      outcome: {
        kind: "review",
        phaseId: "plan_review",
        attemptIdentity: "r5",
        generationId: "gen-old",
        review: {
          ...reviewOutcome("approved", "dec-stale"),
          generationId: "gen-old",
        },
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectReason).toBe("stale_generation");
  });

  it("rejects illegal transitions", () => {
    const result = evaluateTransition(
      baseInput({
        currentPhaseId: "pm_review",
        outcome: {
          kind: "success",
          phaseId: "pm_review",
          attemptIdentity: "illegal",
        },
      }),
    );
    expect(result.accepted).toBe(false);
  });
});
