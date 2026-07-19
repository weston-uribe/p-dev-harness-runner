import { describe, expect, it } from "vitest";
import {
  mergeObservations,
  mergeScores,
  mergeTraces,
  dedupeGaps,
} from "../../src/evaluation/langfuse-inspect/merge.js";
import { buildInspectReport } from "../../src/evaluation/langfuse-inspect/report.js";
import { deriveSessionId } from "../../src/evaluation/identifiers.js";
import type {
  LangfuseInspectGap,
  LangfuseInspectObservation,
  LangfuseInspectScore,
  LangfuseInspectTrace,
} from "../../src/evaluation/langfuse-inspect/types.js";
import { PRICING_REGISTRY_VERSION } from "../../src/evaluation/telemetry/pricing-registry.js";

function baseObs(
  overrides: Partial<LangfuseInspectObservation> = {},
): LangfuseInspectObservation {
  return {
    id: "obs-1",
    name: "FRE-3 · planner · Cursor run",
    type: "GENERATION",
    startTime: null,
    endTime: null,
    model: "composer-2.5",
    hasInput: true,
    hasOutput: true,
    inputByteCount: 1,
    outputByteCount: 1,
    inputSha256: null,
    outputSha256: null,
    usage: { input: 10, output: 5 },
    costUsd: 0.0000175,
    costSource: "pricing_registry",
    costUnavailableReason: null,
    pricingRegistryVersion: PRICING_REGISTRY_VERSION,
    promptName: null,
    promptContractVersion: null,
    skillIds: [],
    skillProvenanceStatus: null,
    toolCount: 0,
    agentId: null,
    cursorRunId: "cr-1",
    linearIssueKey: "FRE-3",
    phase: "planning",
    phaseExecutionId: "pe-1",
    harnessRunId: "run-1",
    revisionCycleIndex: null,
    metadata: { estimatedCostUsd: 0.0000175, effectiveVariant: "standard" },
    ...overrides,
  };
}

describe("langfuse inspect deterministic merge", () => {
  it("collapses identical observation duplicates", () => {
    const a = baseObs();
    const b = baseObs();
    const result = mergeObservations([a, b]);
    expect(result.conflict).toBe(false);
    expect(result.observation.id).toBe("obs-1");
    expect(result.observation.usage?.input).toBe(10);
  });

  it("merges complementary observation fields", () => {
    const a = baseObs({ model: null, usage: { input: 10 } });
    const b = baseObs({
      model: "composer-2.5",
      usage: { output: 5 },
      costUsd: null,
    });
    const result = mergeObservations([a, b]);
    expect(result.conflict).toBe(false);
    expect(result.observation.model).toBe("composer-2.5");
    expect(result.observation.usage).toEqual({ input: 10, output: 5 });
  });

  it("flags conflicting observation identity fields", () => {
    const a = baseObs({ model: "composer-2.5", costUsd: 0.01 });
    const b = baseObs({ model: "other-model", costUsd: 0.02 });
    const result = mergeObservations([a, b]);
    expect(result.conflict).toBe(true);
  });

  it("collapses exact score duplicates and conflicts on value mismatch", () => {
    const score: LangfuseInspectScore = {
      id: "s1",
      name: "phase_success",
      traceId: "t1",
      sessionId: "sess",
      observationId: null,
      dataType: "BOOLEAN",
      value: true,
      timestamp: null,
    };
    expect(mergeScores([score, { ...score }]).conflict).toBe(false);
    expect(
      mergeScores([score, { ...score, value: false }]).conflict,
    ).toBe(true);
  });

  it("merges trace child sets and emits conflict on phase mismatch via report", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: { id: sessionId },
      expectedPhases: ["planning"],
      traces: [
        {
          id: "plan",
          name: "FRE-3 · planning",
          metadata: {
            linearIssueKey: "FRE-3",
            phase: "planning",
            phaseExecutionId: "pe-a",
          },
          observations: [
            {
              id: "gen",
              name: "FRE-3 · planner · Cursor run",
              type: "GENERATION",
              model: "composer-2.5",
              usageDetails: { input: 10, output: 5 },
              metadata: {
                linearIssueKey: "FRE-3",
                phase: "planning",
                phaseExecutionId: "pe-a",
                effectiveVariant: "standard",
                costSource: "pricing_registry",
                estimatedCostUsd: 0.0000175,
                pricingRegistryVersion: PRICING_REGISTRY_VERSION,
              },
              costDetails: { total: 0.0000175 },
            },
            {
              id: "planner",
              name: "FRE-3 · planner",
              type: "AGENT",
              metadata: { linearIssueKey: "FRE-3", phase: "planning" },
            },
          ],
        },
        {
          id: "plan",
          name: "FRE-3 · planning",
          metadata: {
            linearIssueKey: "FRE-3",
            phase: "implementation",
            phaseExecutionId: "pe-b",
          },
          observations: [],
        },
      ],
      observations: [],
      scores: [],
    });
    expect(
      report.gaps.some((g) => g.code === "duplicate_trace_identity_conflict"),
    ).toBe(true);
    expect(report.traces).toHaveLength(1);
  });

  it("counts repeated observation copies once in the report", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const gen = {
      id: "gen",
      name: "FRE-3 · planner · Cursor run",
      type: "GENERATION",
      model: "composer-2.5",
      usageDetails: { input: 10, output: 5 },
      metadata: {
        linearIssueKey: "FRE-3",
        phase: "planning",
        phaseExecutionId: "pe-plan",
        effectiveVariant: "standard",
        costSource: "pricing_registry",
        estimatedCostUsd: 0.0000175,
        pricingRegistryVersion: PRICING_REGISTRY_VERSION,
      },
      costDetails: { total: 0.0000175 },
    };
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: { id: sessionId, name: "FRE-3" },
      expectedPhases: ["planning"],
      traces: [
        {
          id: "plan",
          name: "FRE-3 · planning",
          metadata: {
            linearIssueKey: "FRE-3",
            phase: "planning",
            phaseExecutionId: "pe-plan",
          },
          observations: [
            {
              id: "planner",
              name: "FRE-3 · planner",
              type: "AGENT",
              metadata: { linearIssueKey: "FRE-3", phase: "planning" },
            },
            gen,
            gen,
          ],
        },
      ],
      observations: [
        { ...gen, traceId: "plan" },
        { ...gen, traceId: "plan" },
      ],
      scores: [],
    });
    expect(report.traces[0]?.observations.filter((o) => o.id === "gen")).toHaveLength(
      1,
    );
    expect(report.acceptance.requiredGenerationCount).toBe(1);
  });

  it("dedupes gaps by code/trace/observation/reason not message", () => {
    const gaps: LangfuseInspectGap[] = [
      {
        code: "incomplete_cost_record",
        severity: "error",
        message: "one",
        traceId: "t",
        observationId: "o",
        reasonCode: "missing_input_token_usage",
      },
      {
        code: "incomplete_cost_record",
        severity: "error",
        message: "different message",
        traceId: "t",
        observationId: "o",
        reasonCode: "missing_input_token_usage",
      },
    ];
    expect(dedupeGaps(gaps)).toHaveLength(1);
  });

  it("merges complementary traces without conflict", () => {
    const a: LangfuseInspectTrace = {
      id: "t1",
      name: "FRE-3 · planning",
      sessionId: "s",
      timestamp: null,
      linearIssueKey: "FRE-3",
      phase: "planning",
      phaseExecutionId: "pe",
      harnessRunId: null,
      revisionCycleIndex: null,
      hasInput: false,
      hasOutput: false,
      observations: [baseObs({ id: "a" })],
      scores: [],
      issueIdentityMissing: false,
    };
    const b: LangfuseInspectTrace = {
      ...a,
      harnessRunId: "run-1",
      observations: [baseObs({ id: "b", name: null })],
    };
    const result = mergeTraces([a, b]);
    expect(result.conflict).toBe(false);
    expect(result.trace.harnessRunId).toBe("run-1");
    expect(result.trace.observations).toHaveLength(2);
  });
});
