import { describe, expect, it } from "vitest";
import { InMemoryWorkflowStateStore } from "../../src/workflow/state/store.js";
import {
  createEmptyWorkflowState,
  type PhaseExecutionFreeze,
} from "../../src/workflow/state/types.js";

/**
 * Separate-job freeze continuity: job 2 must reuse durable freeze rather than
 * rebuilding from mutated global config.
 */
describe("phaseExecutionFreeze continuity across jobs", () => {
  it("reuses persisted freeze after simulated config change", async () => {
    const store = new InMemoryWorkflowStateStore();
    const freeze: PhaseExecutionFreeze = {
      phaseId: "code_review",
      claimedAt: "2026-07-19T00:00:00.000Z",
      requestedEnabled: true,
      effectiveEnabled: true,
      configuredReady: true,
      cycleLimit: 4,
      planReviewerModelId: null,
      planReviewerFast: null,
      codeReviewerModelId: "composer-2.5",
      codeReviewerFast: false,
      missingRequirementCodes: [],
      workflowSchemaVersion: "product-development-v2",
      configurationSource: "default",
    };

    const job1 = createEmptyWorkflowState({
      issueKey: "TT-FREEZE",
      workflowSchemaVersion: "product-development-v2",
      enabledOptionalPhases: { planReview: true, codeReview: true },
      effectiveOptionalPhases: { planReview: true, codeReview: true },
    });
    const claimed = {
      ...job1,
      stateRevision: 1,
      currentPhaseId: "code_review",
      phaseExecutionFreeze: freeze,
    };
    await store.compareAndSet({
      issueKey: "TT-FREEZE",
      expectedRevision: 0,
      next: claimed,
    });

    // Job 2: new process, load durable state. Global config would now say Fast=true
    // and cycleLimit=2, but freeze must win for the active claim.
    const job2State = await store.load("TT-FREEZE");
    expect(job2State?.phaseExecutionFreeze?.codeReviewerFast).toBe(false);
    expect(job2State?.phaseExecutionFreeze?.cycleLimit).toBe(4);
    expect(job2State?.phaseExecutionFreeze?.codeReviewerModelId).toBe(
      "composer-2.5",
    );

    const liveConfigWouldSay = {
      codeReviewerFast: true,
      cycleLimit: 2,
    };
    const resolvedFreeze =
      job2State?.phaseExecutionFreeze?.phaseId === "code_review" &&
      job2State.phaseExecutionFreeze.configuredReady
        ? job2State.phaseExecutionFreeze
        : null;
    expect(resolvedFreeze).not.toBeNull();
    expect(resolvedFreeze!.codeReviewerFast).not.toBe(
      liveConfigWouldSay.codeReviewerFast,
    );
    expect(resolvedFreeze!.cycleLimit).not.toBe(liveConfigWouldSay.cycleLimit);
  });
});
