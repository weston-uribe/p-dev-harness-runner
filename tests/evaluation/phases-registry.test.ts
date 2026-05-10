import { describe, expect, it } from "vitest";
import {
  EVALUATION_PHASES,
  isEvaluationPhase,
  phaseInvokesAgent,
} from "../../src/evaluation/phases.js";

describe("evaluation phase registry", () => {
  it("includes planning, integration_repair, and production_sync", () => {
    expect(isEvaluationPhase("planning")).toBe(true);
    expect(isEvaluationPhase("integration_repair")).toBe(true);
    expect(isEvaluationPhase("production_sync")).toBe(true);
    expect(EVALUATION_PHASES.planning.machineKey).toBe("p-dev.planning");
    expect(EVALUATION_PHASES.production_sync.machineKey).toBe(
      "p-dev.production-sync",
    );
    expect(phaseInvokesAgent("planning")).toBe(true);
    expect(phaseInvokesAgent("handoff")).toBe(false);
    expect(phaseInvokesAgent("merge")).toBe(false);
    expect(phaseInvokesAgent("production_sync")).toBe(false);
  });
});
