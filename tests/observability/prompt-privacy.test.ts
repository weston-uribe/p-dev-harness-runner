import { describe, expect, it } from "vitest";
import {
  ALLOWED_PROMPT_ANALYTICS_PROPERTY_KEYS,
  assertAllowedPropertyKeys,
  analyticsEventToProperties,
  FORBIDDEN_PROPERTY_KEY_PATTERNS,
} from "../../src/observability/privacy-schema.js";
import { approvedProductErrorMessage } from "../../src/observability/product-error-messages.js";
import { collectPromptSkillInspectGaps } from "../../src/evaluation/langfuse-inspect/report.js";
import type { LangfuseInspectObservation } from "../../src/evaluation/langfuse-inspect/types.js";

describe("prompt/skill PostHog privacy", () => {
  it("allows bounded prompt_* keys via carve-out without allowing bodies", () => {
    const props = analyticsEventToProperties({
      type: "p_dev_prompt_resolved",
      agentRole: "planner",
      promptName: "p-dev.planning",
      promptSource: "local",
      promptContractVersion: "planning@1",
      remotePromptFallbackUsed: false,
      skillInvocationMode: "rendered_into_prompt",
      skillCount: 1,
      nativeCapabilityState: "unproven",
    });
    expect(props.prompt_name).toBe("p-dev.planning");
    expect(JSON.stringify(props)).not.toMatch(/Canonical skill/);
    expect(JSON.stringify(props)).not.toMatch(/SKILL\.md/);
    assertAllowedPropertyKeys(props, [
      ...ALLOWED_PROMPT_ANALYTICS_PROPERTY_KEYS,
      ...Object.keys(props),
    ]);
  });

  it("still forbids arbitrary prompt-like property keys", () => {
    expect(() =>
      assertAllowedPropertyKeys(
        { prompt_body: "secret instructions" },
        ["prompt_body"],
      ),
    ).toThrow(/forbidden/);
    expect(FORBIDDEN_PROPERTY_KEY_PATTERNS.some((p) => p.test("prompt_body"))).toBe(
      true,
    );
  });
});

describe("prompt/skill Sentry messages", () => {
  it("has approved messages for prompt/skill failure codes without bodies", () => {
    expect(approvedProductErrorMessage("remote_prompt_fetch_failure")).not.toMatch(
      /\{\{/,
    );
    expect(approvedProductErrorMessage("skill_packaging_invalid")).toContain(
      "skill package",
    );
  });
});

describe("inspect false native claims", () => {
  it("flags discovered/invoked without provider_native", () => {
    const obs = {
      id: "gen-1",
      name: "WES-1 · planner · Cursor run",
      type: "GENERATION",
      startTime: null,
      endTime: null,
      model: null,
      hasInput: false,
      hasOutput: false,
      inputByteCount: null,
      outputByteCount: null,
      inputSha256: null,
      outputSha256: null,
      usage: null,
      costUsd: null,
      costSource: null,
      costUnavailableReason: null,
      pricingRegistryVersion: null,
      promptName: "p-dev.planning",
      promptContractVersion: "planning@1",
      skillIds: ["planner"],
      skillProvenanceStatus: "present",
      toolCount: 0,
      agentId: null,
      cursorRunId: null,
      linearIssueKey: "WES-1",
      phase: "planning",
      phaseExecutionId: null,
      harnessRunId: null,
      revisionCycleIndex: null,
      metadata: {
        promptSource: "local",
        langfusePromptLinked: false,
        skillInvocationMode: "rendered_into_prompt",
        skillsUsed: [
          {
            skillId: "planner",
            inclusionMethod: "rendered_into_prompt",
            discovered: true,
            invoked: true,
          },
        ],
      },
    } satisfies LangfuseInspectObservation;
    const gaps = collectPromptSkillInspectGaps(obs, "trace-1");
    expect(gaps.some((g) => g.code === "false_native_skill_claim")).toBe(true);
  });
});
