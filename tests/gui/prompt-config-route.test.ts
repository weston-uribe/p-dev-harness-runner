import { describe, expect, it } from "vitest";
import { buildPromptConfigView } from "../../src/prompts/config-view.js";

describe("prompt config view (GUI read surface)", () => {
  it("never advertises native execution as available", () => {
    const view = buildPromptConfigView({
      provider: "local",
      preferredSkillMode: "native_when_supported",
    });
    expect(view.nativeExecutionAvailable).toBe(false);
    expect(view.nativeCapabilityState).toBe("unproven");
    expect(view.notes.join(" ")).toMatch(/unproven/i);
  });

  it("defaults to local provider", () => {
    const view = buildPromptConfigView();
    expect(view.provider).toBe("local");
  });
});
