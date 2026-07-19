import { describe, expect, it } from "vitest";
import {
  injectPhaseSkills,
  promptNameForPhase,
} from "../../src/prompts/skill-inject.js";

describe("skill inject", () => {
  it("renders planner skill into planning prompts", async () => {
    const result = await injectPhaseSkills({
      phase: "planning",
      basePrompt: "BASE PROMPT",
    });
    expect(result.skillProvenanceStatus).toBe("present");
    expect(result.skillsUsed.some((s) => s.skillId === "planner")).toBe(true);
    expect(result.prompt).toContain("BASE PROMPT");
    expect(result.prompt).toContain("Canonical skill: planner");
    expect(result.skillsUsed[0]?.inclusionMethod).toBe("rendered_into_prompt");
  });

  it("maps prompt names", () => {
    expect(promptNameForPhase("planning")).toBe("p-dev.planning");
    expect(promptNameForPhase("integration_repair")).toBe(
      "p-dev.integration-repair",
    );
  });
});
