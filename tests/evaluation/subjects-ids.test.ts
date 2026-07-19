import { describe, expect, it } from "vitest";
import {
  deriveAgentRunSubjectId,
  derivePhaseExecutionSubjectId,
  deriveRevisionCycleSubjectId,
  deriveToolCallSubjectId,
  deriveWorkflowSessionSubjectId,
} from "../../src/evaluation/subjects/ids.js";
import { derivePhaseExecutionId } from "../../src/evaluation/telemetry/ids.js";

describe("evaluation subject IDs", () => {
  it("derives deterministic IDs", () => {
    const phaseExecutionId = derivePhaseExecutionId(
      "default",
      "run-1",
      "implementation",
    );
    const a = derivePhaseExecutionSubjectId(phaseExecutionId);
    const b = derivePhaseExecutionSubjectId(phaseExecutionId);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);

    const session = "a".repeat(64);
    expect(deriveRevisionCycleSubjectId(session, "comment-1")).toBe(
      deriveRevisionCycleSubjectId(session, "comment-1"),
    );
    expect(deriveWorkflowSessionSubjectId(session)).toBe(
      deriveWorkflowSessionSubjectId(session),
    );
    expect(deriveAgentRunSubjectId(phaseExecutionId, "agent", "run")).toBe(
      deriveAgentRunSubjectId(phaseExecutionId, "agent", "run"),
    );
    expect(deriveToolCallSubjectId(phaseExecutionId, "call-1")).toBe(
      deriveToolCallSubjectId(phaseExecutionId, "call-1"),
    );
  });

  it("changes when canonical inputs change", () => {
    const session = "b".repeat(64);
    expect(deriveRevisionCycleSubjectId(session, "c1")).not.toBe(
      deriveRevisionCycleSubjectId(session, "c2"),
    );
  });
});
