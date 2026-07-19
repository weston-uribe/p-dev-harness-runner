import { describe, expect, it, afterEach } from "vitest";
import {
  assertNoProductionCursorSkillsMirror,
  CANONICAL_SKILLS_DIR,
  discoverCanonicalSkills,
} from "../../src/skills/package.js";
import {
  getNativeSkillCapability,
  isCursorCliAvailableInEnvironment,
  mayAttemptNativeSkillInProduction,
  NATIVE_SKILL_CANARY_CANDIDATE_LAYOUTS,
  NATIVE_SKILL_CAPABILITY_REGISTRY_VERSION,
  productionNativeSkillCapability,
  setCursorCliAvailabilityProbeForTests,
} from "../../src/skills/capability.js";
import {
  assertNoDuplicateSkillInjection,
  executeSkillsForPhase,
} from "../../src/skills/execute.js";
import { injectPhaseSkills } from "../../src/prompts/skill-inject.js";

describe("canonical skill packages", () => {
  it("discovers and validates .agents/skills packages", async () => {
    const result = await discoverCanonicalSkills();
    expect(result.errors).toEqual([]);
    expect(result.packages.length).toBeGreaterThanOrEqual(6);
    for (const pkg of result.packages) {
      expect(pkg.valid).toBe(true);
      expect(pkg.sourcePath.startsWith(`${CANONICAL_SKILLS_DIR}/`)).toBe(true);
      expect(pkg.contentSha256).toHaveLength(64);
      expect(pkg.frontmatter.skillContractVersion).toBe("1");
      expect(pkg.frontmatter.description.length).toBeGreaterThan(20);
    }
  });

  it("asserts no production .cursor/skills mirror", async () => {
    const check = await assertNoProductionCursorSkillsMirror();
    expect(check.ok).toBe(true);
  });

  it("lists canary candidate layouts without treating them as production", () => {
    expect(NATIVE_SKILL_CANARY_CANDIDATE_LAYOUTS).toContain(
      ".agents/skills/<skillId>/SKILL.md",
    );
    expect(NATIVE_SKILL_CANARY_CANDIDATE_LAYOUTS).toContain(
      ".cursor/skills/<skillId>/SKILL.md",
    );
  });
});

describe("native skill capability taxonomy", () => {
  afterEach(() => {
    setCursorCliAvailabilityProbeForTests(null);
  });

  it("marks sdk_cloud_agent as unproven and forbids production native attempts", () => {
    expect(productionNativeSkillCapability()).toBe("unproven");
    expect(mayAttemptNativeSkillInProduction()).toBe(false);
    expect(getNativeSkillCapability("sdk_cloud_agent").state).toBe("unproven");
    expect(NATIVE_SKILL_CAPABILITY_REGISTRY_VERSION).toMatch(/v2$/);
  });

  it("marks editor and background_agent as unproven", () => {
    expect(getNativeSkillCapability("cursor_editor").state).toBe("unproven");
    expect(getNativeSkillCapability("background_agent").state).toBe("unproven");
    expect(getNativeSkillCapability("sdk_local_agent").state).toBe("unproven");
  });

  it("does not mark CLI unsupported merely because the binary is absent", () => {
    setCursorCliAvailabilityProbeForTests(() => false);

    expect(isCursorCliAvailableInEnvironment()).toBe(false);
    expect(getNativeSkillCapability("cursor_cli_interactive").state).toBe(
      "unavailable_in_environment",
    );
    expect(getNativeSkillCapability("cursor_cli_non_interactive").state).toBe(
      "unavailable_in_environment",
    );
    expect(getNativeSkillCapability("cursor_cli_interactive").state).not.toBe(
      "unsupported",
    );
  });

  it("marks CLI unproven when the binary is present but skills are untested", () => {
    setCursorCliAvailabilityProbeForTests(() => true);

    expect(isCursorCliAvailableInEnvironment()).toBe(true);
    expect(getNativeSkillCapability("cursor_cli_interactive").state).toBe(
      "unproven",
    );
    expect(getNativeSkillCapability("cursor_cli_non_interactive").state).toBe(
      "unproven",
    );
  });
});

describe("skill execution production path", () => {
  it("renders skills and never claims discovered/invoked", async () => {
    const executed = await executeSkillsForPhase({
      requests: [
        {
          skillId: "planner",
          role: "planning_guidance",
          sourcePath: ".agents/skills/planner/SKILL.md",
        },
      ],
      preferredMode: "native_when_supported",
      allowNativeAttempt: true,
    });
    expect(executed.results).toHaveLength(1);
    const r = executed.results[0]!;
    expect(r.invocationMode).toBe("rendered_into_prompt");
    expect(r.discovered).toBeNull();
    expect(r.invoked).toBeNull();
    expect(r.evidenceSource).toBe("local_render");
    expect(r.fallbackReason).toBe("native_capability_unproven");
    expect(executed.promptSuffix).toContain("Canonical skill: planner");
  });

  it("rejects loading skills outside .agents/skills", async () => {
    const executed = await executeSkillsForPhase({
      requests: [
        {
          skillId: "evil",
          role: "x",
          sourcePath: ".cursor/skills/evil/SKILL.md",
        },
      ],
    });
    expect(executed.results[0]?.invocationMode).toBe("none");
    expect(executed.promptSuffix).toBe("");
  });

  it("does not dual-inject native body when rendered", async () => {
    const injection = await injectPhaseSkills({
      phase: "planning",
      basePrompt: "BASE",
    });
    const check = assertNoDuplicateSkillInjection(
      injection.skillResults,
      injection.prompt,
    );
    expect(check.ok).toBe(true);
    expect(injection.skillsUsed[0]?.discovered).toBeNull();
    expect(injection.skillsUsed[0]?.invoked).toBeNull();
  });
});
