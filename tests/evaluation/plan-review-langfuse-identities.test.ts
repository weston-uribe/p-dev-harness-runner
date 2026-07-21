import { describe, expect, it } from "vitest";
import {
  agentObservationDisplayName,
  phaseTraceDisplayName,
} from "../../src/evaluation/naming.js";

describe("Plan Review Langfuse identities", () => {
  it("uses deterministic phase and agent observation names", () => {
    expect(phaseTraceDisplayName({ issueKey: "FRE-6", phase: "plan_review" })).toBe(
      "FRE-6 · plan_review",
    );
    expect(
      agentObservationDisplayName({ issueKey: "FRE-6", role: "plan_reviewer" }),
    ).toBe("FRE-6 · plan_reviewer");
  });

  it("planning and plan_review names stay distinct in the same issue session", () => {
    const planning = phaseTraceDisplayName({
      issueKey: "FRE-6",
      phase: "planning",
    });
    const planReview = phaseTraceDisplayName({
      issueKey: "FRE-6",
      phase: "plan_review",
    });
    expect(planning).not.toBe(planReview);
    expect(planning).toContain("planning");
    expect(planReview).toContain("plan_review");
  });
});
