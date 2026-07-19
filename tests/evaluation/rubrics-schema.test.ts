import { describe, expect, it } from "vitest";
import { loadAllRubrics } from "../../src/evaluation/rubrics/load.js";
import { validateRubric } from "../../src/evaluation/rubrics/validate.js";

describe("rubric schema and v1 definitions", () => {
  it("loads and validates all v1 rubrics with explicit judgmentChannel", async () => {
    const rubrics = await loadAllRubrics();
    expect(rubrics.length).toBe(8);
    for (const rubric of rubrics) {
      const result = validateRubric(rubric);
      expect(result.ok).toBe(true);
      expect(rubric.rubricVersion).toBe("1");
      expect(["human", "machine"]).toContain(rubric.judgmentChannel);
      for (const dimension of rubric.dimensions) {
        expect(dimension.anchors.length).toBeGreaterThan(0);
      }
    }
    const human = rubrics
      .filter((r) => r.judgmentChannel === "human")
      .map((r) => r.rubricId)
      .sort();
    const machine = rubrics
      .filter((r) => r.judgmentChannel === "machine")
      .map((r) => r.rubricId)
      .sort();
    expect(human).toEqual([
      "implementation-quality",
      "planning-quality",
      "revision-quality",
      "workflow-quality",
    ]);
    expect(machine).toEqual([
      "execution-contract",
      "revision-contract",
      "telemetry-integrity",
      "workflow-integrity",
    ]);
  });

  it("rejects missing judgmentChannel", () => {
    const result = validateRubric({
      rubricId: "x",
      rubricVersion: "1",
      name: "x",
      description: "x",
      applicableSubjectTypes: ["phase_execution"],
      applicablePhases: ["implementation"],
      dimensions: [
        {
          dimensionId: "d",
          name: "d",
          description: "d",
          responseType: "boolean",
          allowedValues: [true, false],
          anchors: [
            { value: true, label: "t", definition: "t" },
            { value: false, label: "f", definition: "f" },
          ],
          requiredEvidence: [],
          optionalEvidence: [],
          allowCorrectedOutput: false,
          reviewerCommentRequired: false,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("judgmentChannel"))).toBe(true);
  });

  it("rejects invalid rubrics", () => {
    const result = validateRubric({
      rubricId: "x",
      rubricVersion: "1",
      name: "x",
      description: "x",
      judgmentChannel: "human",
      applicableSubjectTypes: ["phase_execution"],
      applicablePhases: ["implementation"],
      dimensions: [],
    });
    expect(result.ok).toBe(false);
  });
});
