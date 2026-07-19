import { describe, expect, it } from "vitest";
import {
  EVALUATION_PHASES,
  isEvaluationPhase,
  phaseInvokesAgent,
} from "../../src/evaluation/phases.js";

describe("evaluation phase registry", () => {
  it("includes planning and integration_repair", () => {
    expect(isEvaluationPhase("planning")).toBe(true);
    expect(isEvaluationPhase("integration_repair")).toBe(true);
    expect(EVALUATION_PHASES.planning.machineKey).toBe("p-dev.planning");
    expect(phaseInvokesAgent("planning")).toBe(true);
    expect(phaseInvokesAgent("handoff")).toBe(false);
    expect(phaseInvokesAgent("merge")).toBe(false);
  });
});
