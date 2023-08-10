import { describe, expect, it } from "vitest";
import { formatPlanningComment } from "../../src/linear/comments.js";
import { buildPlanReviewSubjectIdentity } from "../../src/workflow/subject-identities.js";
import {
  buildPlanReviewDeliveryId,
  buildPlanReviewRequestId,
} from "../../src/workflow/plan-review-dispatch-effect.js";

describe("planning → plan review dispatch contract", () => {
  it("harness-authored Plan Review next step does not claim Implementation starts", () => {
    const withReview = formatPlanningComment(
      "Plan body",
      {
        runId: "run-1",
        targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
        orchestratorMarker: "harness-orchestrator-v1",
        promptVersion: "planning@1",
      },
      { planReviewNext: true },
    );
    expect(withReview).toContain("Plan Review will start automatically");

    const withoutReview = formatPlanningComment("Plan body", {
      runId: "run-1",
      targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
      orchestratorMarker: "harness-orchestrator-v1",
      promptVersion: "planning@1",
    });
    expect(withoutReview).toContain("Implementation will start automatically");
  });

  it("deterministic subject and opaque request id are stable for FRE-6 artifact", () => {
    const subject = buildPlanReviewSubjectIdentity({
      issueKey: "FRE-6",
      planGenerationId: "120aa5ff-005a-44e7-aa5a-0b4922d951b4",
      planHash:
        "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6",
      reviewCycle: 0,
    });
    const again = buildPlanReviewSubjectIdentity({
      issueKey: "FRE-6",
      planGenerationId: "120aa5ff-005a-44e7-aa5a-0b4922d951b4",
      planHash:
        "84076eff91fba2a0d2dd61d7da598f594d6362dd97186f1f3c7e4ef4dec56ba6",
      reviewCycle: 0,
    });
    expect(subject).toBe(again);
    expect(buildPlanReviewDeliveryId(subject)).toBe(`pr-subject:${subject}`);
    const requestId = buildPlanReviewRequestId(subject);
    expect(requestId).toMatch(/^dlv-[a-f0-9]{32}$/);
    expect(buildPlanReviewRequestId(subject)).toBe(requestId);
  });

  it("rejected review cycle increments subject identity (no implementation from rejected artifact)", () => {
    const cycle0 = buildPlanReviewSubjectIdentity({
      issueKey: "FRE-6",
      planGenerationId: "gen-a",
      planHash: "hash-a",
      reviewCycle: 0,
    });
    const cycle1 = buildPlanReviewSubjectIdentity({
      issueKey: "FRE-6",
      planGenerationId: "gen-b",
      planHash: "hash-b",
      reviewCycle: 1,
    });
    expect(cycle0).not.toBe(cycle1);
  });
});
