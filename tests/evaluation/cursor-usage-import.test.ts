import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCursorUsageCsv, tokensSumValid } from "../../src/evaluation/cursor-usage-import/parse.js";
import { aggregateByCloudAgentId } from "../../src/evaluation/cursor-usage-import/aggregate.js";
import { computeCostProxies } from "../../src/evaluation/cursor-usage-import/proxy-cost.js";
import { buildPhaseUsageScores } from "../../src/evaluation/cursor-usage-import/scores.js";
import { projectUsageScoresOnly } from "../../src/evaluation/cursor-usage-import/project.js";
import {
  evaluateVerdicts,
  verifyImportedScores,
} from "../../src/evaluation/cursor-usage-import/verify.js";
import { joinAggregatesToPhaseTraces } from "../../src/evaluation/cursor-usage-import/join.js";
import { ALL_INPUT_AT_LIST_RATE_COMMENT } from "../../src/evaluation/cursor-usage-import/types.js";
import { deriveScoreId } from "../../src/evaluation/identifiers.js";
import type { LangfuseInspectReport } from "../../src/evaluation/langfuse-inspect/types.js";
import type { EvaluationScoreInput } from "../../src/evaluation/types.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cursor-usage",
);

function makeInspectReport(): LangfuseInspectReport {
  return {
    schemaVersion: 1,
    issueKey: "TT-FIXTURE",
    namespace: "default",
    sessionId: "a".repeat(64),
    sessionDisplayName: null,
    inspectedAt: new Date().toISOString(),
    expectedPhases: ["planning", "plan_review"],
    traces: [
      {
        id: "trace-planning",
        name: "planning",
        sessionId: "a".repeat(64),
        timestamp: "2026-07-19T11:59:00.000Z",
        linearIssueKey: "TT-FIXTURE",
        phase: "planning",
        phaseExecutionId: "pe-plan",
        harnessRunId: "hr-plan",
        revisionCycleIndex: null,
        hasInput: false,
        hasOutput: false,
        observations: [
          {
            id: "obs-plan",
            name: "planner",
            type: "AGENT",
            startTime: "2026-07-19T11:59:00.000Z",
            endTime: "2026-07-19T12:05:00.000Z",
            model: "composer-2.5",
            hasInput: false,
            hasOutput: false,
            inputByteCount: null,
            outputByteCount: null,
            inputSha256: null,
            outputSha256: null,
            usage: null,
            costUsd: null,
            costSource: "unavailable",
            costUnavailableReason: "provider_did_not_report",
            pricingRegistryVersion: null,
            promptName: null,
            promptContractVersion: null,
            skillIds: [],
            skillProvenanceStatus: null,
            toolCount: 0,
            agentId: "bc-agent-planning-001",
            cursorRunId: "run-1",
            linearIssueKey: "TT-FIXTURE",
            phase: "planning",
            phaseExecutionId: "pe-plan",
            harnessRunId: "hr-plan",
            revisionCycleIndex: null,
            metadata: {
              cursorAgentId: "bc-agent-planning-001",
              effectiveVariant: "standard",
              fast: false,
            },
          },
        ],
        scores: [],
        issueIdentityMissing: false,
      },
      {
        id: "trace-plan-review",
        name: "plan_review",
        sessionId: "a".repeat(64),
        timestamp: "2026-07-19T12:59:00.000Z",
        linearIssueKey: "TT-FIXTURE",
        phase: "plan_review",
        phaseExecutionId: "pe-pr",
        harnessRunId: "hr-pr",
        revisionCycleIndex: null,
        hasInput: false,
        hasOutput: false,
        observations: [
          {
            id: "obs-pr",
            name: "plan_reviewer",
            type: "AGENT",
            startTime: "2026-07-19T12:59:00.000Z",
            endTime: "2026-07-19T13:05:00.000Z",
            model: "composer-2.5",
            hasInput: false,
            hasOutput: false,
            inputByteCount: null,
            outputByteCount: null,
            inputSha256: null,
            outputSha256: null,
            usage: null,
            costUsd: null,
            costSource: "unavailable",
            costUnavailableReason: "provider_did_not_report",
            pricingRegistryVersion: null,
            promptName: null,
            promptContractVersion: null,
            skillIds: [],
            skillProvenanceStatus: null,
            toolCount: 0,
            agentId: "bc-agent-planreview-001",
            cursorRunId: "run-2",
            linearIssueKey: "TT-FIXTURE",
            phase: "plan_review",
            phaseExecutionId: "pe-pr",
            harnessRunId: "hr-pr",
            revisionCycleIndex: null,
            metadata: {
              cursorAgentId: "bc-agent-planreview-001",
              effectiveVariant: "standard",
              fast: false,
            },
          },
        ],
        scores: [],
        issueIdentityMissing: false,
      },
    ],
    scores: [],
    gaps: [],
    acceptance: {
      coreComplete: false,
      complete: false,
      missingVisibleIssueKey: false,
      hasPlanningTrace: true,
      hasPlannerAgent: true,
      hasPlanReviewTrace: true,
      hasPlanReviewerAgent: true,
      requiredTracesPresent: true,
      requiredAgentsPresent: true,
      requiredGenerationsPresent: true,
      planningTraceNames: ["planning"],
      plannerAgentNames: ["planner"],
      planReviewTraceNames: ["plan_review"],
      planReviewerAgentNames: ["plan_reviewer"],
      agentObservationNames: [],
      generationCostComplete: false,
      requiredGenerationCount: 2,
      costCompleteGenerationCount: 0,
      incompleteRequiredGenerationCount: 2,
      uniqueGenerationCandidateCount: 2,
      excludedGenerationCandidateCount: 0,
      errorGapCount: 0,
      warningGapCount: 0,
      scoreNames: [],
      cursorCsvTokenAcceptance: false,
      cursorCsvCostProxyAvailable: false,
      cursorCsvExactMonetaryCostAcceptance: false,
      cursorGenerationNativeUsageComplete: false,
    },
    artifactComparison: { localRunCount: 0, conflictingCorrelations: [] },
  };
}

describe("cursor-usage-import", () => {
  const csv = readFileSync(path.join(fixtureDir, "sample-usage.csv"), "utf8");

  it("parses CSV and validates token arithmetic", () => {
    const parsed = parseCursorUsageCsv(csv);
    expect(parsed.arithmetic.identityHolds).toBe(true);
    expect(parsed.rows).toHaveLength(3);
    expect(tokensSumValid(parsed.rows[0]!.tokens)).toBe(true);
  });

  it("aggregates multiple rows per agent without duplication", () => {
    const parsed = parseCursorUsageCsv(csv);
    const { aggregates } = aggregateByCloudAgentId(parsed.rows);
    const planning = aggregates.find((a) => a.cloudAgentId === "bc-agent-planning-001");
    expect(planning?.rowCount).toBe(2);
    expect(planning?.tokens.inputTokens).toBe(350);
    expect(planning?.tokens.cacheWriteTokens).toBe(100);
    expect(planning?.tokens.cacheReadTokens).toBe(700);
    expect(planning?.tokens.outputTokens).toBe(75);
    expect(planning?.tokens.totalTokens).toBe(1225);
  });

  it("dedupes identical fingerprints on re-aggregate", () => {
    const parsed = parseCursorUsageCsv(csv);
    const doubled = [...parsed.rows, ...parsed.rows];
    const { aggregates } = aggregateByCloudAgentId(doubled);
    const planning = aggregates.find((a) => a.cloudAgentId === "bc-agent-planning-001");
    expect(planning?.rowCount).toBe(2);
  });

  it("joins only planning and plan_review agents", () => {
    const parsed = parseCursorUsageCsv(csv);
    const { aggregates } = aggregateByCloudAgentId(parsed.rows);
    const { joins, skipped } = joinAggregatesToPhaseTraces({
      report: makeInspectReport(),
      aggregates,
      allowedPhases: ["planning", "plan_review"],
    });
    expect(joins).toHaveLength(2);
    expect(joins.map((j) => j.join.phase).sort()).toEqual([
      "plan_review",
      "planning",
    ]);
    expect(skipped.filter((s) => s.reason === "ambiguous_multi_phase_mapping")).toHaveLength(0);
  });

  it("computes proxies excluding cache from known-noncache and including in all-input-at-list-rate", () => {
    const tokens = {
      inputTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 3_000_000,
    };
    const standard = computeCostProxies({
      modelId: "composer-2.5",
      effectiveVariant: "standard",
      tokens,
    })!;
    // known: 0.5 + 2.5 = 3.0
    expect(standard.knownNoncacheCostUsd).toBeCloseTo(3.0, 9);
    // all input at list: (1M+1M)*0.5 + 1M*2.5 = 1 + 2.5 = 3.5
    expect(standard.allInputAtListRateUsd).toBeCloseTo(3.5, 9);

    const fast = computeCostProxies({
      modelId: "composer-2.5",
      effectiveVariant: "fast",
      tokens,
    })!;
    expect(fast.knownNoncacheCostUsd).toBeCloseTo(18.0, 9);
    expect(fast.allInputAtListRateUsd).toBeCloseTo(21.0, 9);
  });

  it("builds deterministic scores with stable timestamps and privacy-safe comments", () => {
    const scores = buildPhaseUsageScores({
      namespace: "default",
      join: {
        phase: "planning",
        traceId: "trace-planning",
        traceEndTimestamp: "2026-07-19T12:05:00.000Z",
        harnessRunId: "hr",
        phaseExecutionId: "pe",
        cursorAgentId: "bc-agent-planning-001",
        cursorAgentIdHash: "abc",
        effectiveVariant: "standard",
        sdkFast: false,
      },
      tokens: {
        inputTokens: 10,
        cacheWriteTokens: 1,
        cacheReadTokens: 2,
        outputTokens: 3,
        totalTokens: 16,
      },
      knownNoncacheCostUsd: 0.01,
      allInputAtListRateUsd: 0.02,
    });
    expect(scores).toHaveLength(11);
    expect(scores.every((s) => s.timestamp === "2026-07-19T12:05:00.000Z")).toBe(
      true,
    );
    const again = buildPhaseUsageScores({
      namespace: "default",
      join: {
        phase: "planning",
        traceId: "trace-planning",
        traceEndTimestamp: "2026-07-19T12:05:00.000Z",
        harnessRunId: "hr",
        phaseExecutionId: "pe",
        cursorAgentId: "bc-agent-planning-001",
        cursorAgentIdHash: "abc",
        effectiveVariant: "standard",
        sdkFast: false,
      },
      tokens: {
        inputTokens: 10,
        cacheWriteTokens: 1,
        cacheReadTokens: 2,
        outputTokens: 3,
        totalTokens: 16,
      },
      knownNoncacheCostUsd: 0.01,
      allInputAtListRateUsd: 0.02,
    });
    expect(scores.map((s) => s.id)).toEqual(again.map((s) => s.id));
    const proxy = scores.find((s) => s.name === "cursor_all_input_at_list_rate_usd");
    expect(proxy?.comment).toBe(ALL_INPUT_AT_LIST_RATE_COMMENT);
    expect(proxy?.comment).not.toMatch(/TT-|bc-agent|\.csv|github/i);
    expect(
      scores.find((s) => s.name === "cursor_generation_native_usage_complete")
        ?.value,
    ).toBe(false);
    expect(
      scores.find((s) => s.name === "cursor_exact_cost_complete")?.value,
    ).toBe(false);
  });

  it("never attempts observation mutation in projectUsageScoresOnly", () => {
    const recorded: EvaluationScoreInput[] = [];
    const recorder = {
      recordScore(input: EvaluationScoreInput) {
        recorded.push(input);
      },
    };
    const scores = buildPhaseUsageScores({
      namespace: "default",
      join: {
        phase: "planning",
        traceId: "trace-planning",
        traceEndTimestamp: "2026-07-19T12:05:00.000Z",
        harnessRunId: null,
        phaseExecutionId: null,
        cursorAgentId: "x",
        cursorAgentIdHash: "x",
        effectiveVariant: "standard",
        sdkFast: false,
      },
      tokens: {
        inputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 1,
        totalTokens: 2,
      },
      knownNoncacheCostUsd: 0,
      allInputAtListRateUsd: 0,
    });
    const result = projectUsageScoresOnly({ recorder, scores });
    expect(result.observationMutationAttempted).toBe(false);
    expect(recorded).toHaveLength(11);
  });

  it("verifies scores and keeps exact-cost acceptance false", () => {
    const parsed = parseCursorUsageCsv(csv);
    const { aggregates } = aggregateByCloudAgentId(parsed.rows);
    const { joins } = joinAggregatesToPhaseTraces({
      report: makeInspectReport(),
      aggregates,
      allowedPhases: ["planning", "plan_review"],
    });
    const attachments = joins.map(({ join, aggregate }) => {
      const proxies = computeCostProxies({
        modelId: "composer-2.5",
        effectiveVariant: join.effectiveVariant,
        tokens: aggregate.tokens,
      })!;
      const scores = buildPhaseUsageScores({
        namespace: "default",
        join,
        tokens: aggregate.tokens,
        knownNoncacheCostUsd: proxies.knownNoncacheCostUsd,
        allInputAtListRateUsd: proxies.allInputAtListRateUsd,
      });
      return { join, aggregate, proxies, scores };
    });

    const fetched = attachments.flatMap((a) =>
      a.scores.map((s) => ({
        id: s.id,
        name: s.name,
        traceId: s.traceId ?? null,
        value: s.dataType === "BOOLEAN" ? (s.value === true ? 1 : 0) : s.value,
        dataType: s.dataType,
        timestamp: s.timestamp,
      })),
    );
    const verify = verifyImportedScores({
      attachments,
      fetchedScores: fetched,
      retrievalCompletenessProven: true,
    });
    expect(verify.verified).toBe(true);
    expect(verify.logicalScoreCount).toBe(22);
    expect(verify.physicalMatchingScoreCount).toBe(22);

    // second pass same ids → same logical and physical counts
    const verify2 = verifyImportedScores({
      attachments,
      fetchedScores: fetched,
      retrievalCompletenessProven: true,
    });
    expect(verify2.logicalScoreCount).toBe(verify.logicalScoreCount);
    expect(verify2.physicalMatchingScoreCount).toBe(
      verify.physicalMatchingScoreCount,
    );

    const verdicts = evaluateVerdicts({
      arithmeticValid: true,
      attachments,
      verify,
      generationCostComplete: false,
    });
    expect(verdicts.tokenAcceptance).toBe(true);
    expect(verdicts.costProxyAvailability).toBe(true);
    expect(verdicts.exactMonetaryCostAcceptance).toBe(false);
  });

  it("updates complete score values when additional rows increase totals (same score ids)", () => {
    const join = {
      phase: "planning" as const,
      traceId: "trace-planning",
      traceEndTimestamp: "2026-07-19T12:05:00.000Z",
      harnessRunId: null,
      phaseExecutionId: null,
      cursorAgentId: "bc",
      cursorAgentIdHash: "h",
      effectiveVariant: "standard" as const,
      sdkFast: false,
    };
    const s1 = buildPhaseUsageScores({
      namespace: "default",
      join,
      tokens: {
        inputTokens: 10,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 1,
        totalTokens: 11,
      },
      knownNoncacheCostUsd: 0.001,
      allInputAtListRateUsd: 0.001,
    });
    const s2 = buildPhaseUsageScores({
      namespace: "default",
      join,
      tokens: {
        inputTokens: 30,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 2,
        totalTokens: 32,
      },
      knownNoncacheCostUsd: 0.003,
      allInputAtListRateUsd: 0.003,
    });
    expect(s1.map((s) => s.id)).toEqual(s2.map((s) => s.id));
    expect(s1[0]!.timestamp).toBe(s2[0]!.timestamp);
    expect(s1.find((s) => s.name === "cursor_input_tokens")!.value).toBe(10);
    expect(s2.find((s) => s.name === "cursor_input_tokens")!.value).toBe(30);
    expect(
      deriveScoreId("default", "trace", "trace-planning", "cursor_input_tokens"),
    ).toBe(s1.find((s) => s.name === "cursor_input_tokens")!.id);
  });
});
