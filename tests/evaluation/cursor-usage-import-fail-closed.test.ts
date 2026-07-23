import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  paginateScoresLegacy,
  paginateScoresV3,
} from "../../src/evaluation/langfuse-inspect/client.js";
import { parseCursorUsageCsv } from "../../src/evaluation/cursor-usage-import/parse.js";
import { aggregateByCloudAgentId } from "../../src/evaluation/cursor-usage-import/aggregate.js";
import { computeCostProxies } from "../../src/evaluation/cursor-usage-import/proxy-cost.js";
import { buildPhaseUsageScores } from "../../src/evaluation/cursor-usage-import/scores.js";
import {
  joinAggregatesToPhaseTraces,
  validateCanonicalCsvPhaseTraces,
} from "../../src/evaluation/cursor-usage-import/join.js";
import {
  evaluateVerdicts,
  verifyImportedScores,
  type FetchedScore,
} from "../../src/evaluation/cursor-usage-import/verify.js";
import { runCursorUsageImport } from "../../src/evaluation/cursor-usage-import/run.js";
import { evaluateCursorCsvScoreAcceptance } from "../../src/evaluation/langfuse-inspect/report.js";
import type { LangfuseInspectReport } from "../../src/evaluation/langfuse-inspect/types.js";
import type { PhaseImportAttachment } from "../../src/evaluation/cursor-usage-import/types.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cursor-usage",
);
const csv = readFileSync(path.join(fixtureDir, "sample-usage.csv"), "utf8");

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

function buildAttachments(): PhaseImportAttachment[] {
  const parsed = parseCursorUsageCsv(csv);
  const { aggregates } = aggregateByCloudAgentId(parsed.rows);
  const { joins } = joinAggregatesToPhaseTraces({
    report: makeInspectReport(),
    aggregates,
    allowedPhases: ["planning", "plan_review"],
  });
  return joins.map(({ join, aggregate }) => {
    const proxies = computeCostProxies({
      modelId: "composer-2.5",
      effectiveVariant: join.effectiveVariant,
      tokens: aggregate.tokens,
    })!;
    return {
      join,
      aggregate,
      proxies,
      scores: buildPhaseUsageScores({
        namespace: "default",
        join,
        tokens: aggregate.tokens,
        knownNoncacheCostUsd: proxies.knownNoncacheCostUsd,
        allInputAtListRateUsd: proxies.allInputAtListRateUsd,
        tokenUsageComplete: true,
        sourceScopeComplete: true,
        listPriceEquivalentComplete: false,
        providerActualCostComplete: false,
        costProxyAvailable: true,
        sourceDigestPrefix: "a".repeat(64),
      }),
    };
  });
}

function toFetched(attachments: PhaseImportAttachment[]): FetchedScore[] {
  return attachments.flatMap((a) =>
    a.scores.map((s) => ({
      id: s.id,
      name: s.name,
      traceId: s.traceId ?? null,
      value: s.dataType === "BOOLEAN" ? (s.value === true ? 1 : 0) : s.value,
      dataType: s.dataType,
      timestamp: s.timestamp ?? null,
    })),
  );
}

describe("cursor-usage-import fail-closed (8F.1)", () => {
  it("fails when 22 unique IDs are represented by 44 physical records", () => {
    const attachments = buildAttachments();
    const once = toFetched(attachments);
    const duplicated = [...once, ...once];
    const verify = verifyImportedScores({
      attachments,
      fetchedScores: duplicated,
      retrievalCompletenessProven: true,
    });
    expect(verify.uniqueMatchingDeterministicIds).toBe(28);
    expect(verify.physicalMatchingScoreCount).toBe(56);
    expect(verify.logicalScoreCount).toBe(0);
    expect(verify.verified).toBe(false);
    expect(verify.mismatches.some((m) => m.startsWith("duplicate_"))).toBe(
      true,
    );
  });

  it("fails when expected ID missing but same name/value exists", () => {
    const attachments = buildAttachments();
    const fetched = toFetched(attachments).map((s, i) =>
      i === 0 ? { ...s, id: "wrong-id-not-deterministic" } : s,
    );
    const verify = verifyImportedScores({
      attachments,
      fetchedScores: fetched,
      retrievalCompletenessProven: true,
    });
    expect(verify.verified).toBe(false);
    expect(verify.logicalScoreCount).toBeLessThan(28);
    expect(
      verify.mismatches.some((m) =>
        m.startsWith("expected_score_id_missing_but_name_match_present:"),
      ),
    ).toBe(true);
  });

  it("fails on wrong trace, null trace, wrong timestamp, wrong data type", () => {
    const attachments = buildAttachments();
    const base = toFetched(attachments);
    const wrongTrace = base.map((s, i) =>
      i === 0 ? { ...s, traceId: "other-trace" } : s,
    );
    expect(
      verifyImportedScores({
        attachments,
        fetchedScores: wrongTrace,
        retrievalCompletenessProven: true,
      }).mismatches.some((m) => m.startsWith("wrong_trace:")),
    ).toBe(true);

    const nullTrace = base.map((s, i) =>
      i === 0 ? { ...s, traceId: null } : s,
    );
    expect(
      verifyImportedScores({
        attachments,
        fetchedScores: nullTrace,
        retrievalCompletenessProven: true,
      }).mismatches.some((m) => m.startsWith("null_trace_id:")),
    ).toBe(true);

    const wrongTs = base.map((s, i) =>
      i === 0 ? { ...s, timestamp: "2020-01-01T00:00:00.000Z" } : s,
    );
    expect(
      verifyImportedScores({
        attachments,
        fetchedScores: wrongTs,
        retrievalCompletenessProven: true,
      }).mismatches.some((m) => m.startsWith("timestamp_mismatch:")),
    ).toBe(true);

    const wrongType = base.map((s, i) =>
      i === 0 ? { ...s, dataType: "CATEGORICAL" } : s,
    );
    expect(
      verifyImportedScores({
        attachments,
        fetchedScores: wrongType,
        retrievalCompletenessProven: true,
      }).mismatches.some((m) => m.startsWith("data_type_mismatch:")),
    ).toBe(true);
  });

  it("fails duplicate (traceId, name) with a different ID", () => {
    const attachments = buildAttachments();
    const base = toFetched(attachments).map((s) => ({
      ...s,
      comment: "cursor_usage_import scoreClass=cursor_usage_import",
    }));
    const extra = {
      ...base[0]!,
      id: "totally-different-id",
      comment: "cursor_usage_import scoreClass=cursor_usage_import",
    };
    const verify = verifyImportedScores({
      attachments,
      fetchedScores: [...base, extra],
      retrievalCompletenessProven: true,
    });
    expect(verify.verified).toBe(false);
    expect(
      verify.mismatches.some((m) => m.startsWith("duplicate_trace_name:")),
    ).toBe(true);
  });

  it("ignores unrelated probe scores for (traceId, name) uniqueness", () => {
    const attachments = buildAttachments();
    const base = toFetched(attachments).map((s) => ({
      ...s,
      comment: "cursor_usage_import scoreClass=cursor_usage_import",
    }));
    const probe = {
      ...base[0]!,
      id: "probe-not-deterministic",
      comment: "probe",
    };
    const verify = verifyImportedScores({
      attachments,
      fetchedScores: [...base, probe],
      retrievalCompletenessProven: true,
    });
    expect(verify.verified).toBe(true);
    expect(verify.physicalMatchingScoreCount).toBe(28);
  });

  it("fails closed when retrieval completeness is unproven", () => {
    const attachments = buildAttachments();
    const verify = verifyImportedScores({
      attachments,
      fetchedScores: toFetched(attachments),
      retrievalCompletenessProven: false,
    });
    expect(verify.verified).toBe(false);
    expect(verify.mismatches).toContain("score_fetch_may_be_truncated");
  });

  it("paginateScoresV3 retrieves duplicates on a later page without collapsing", async () => {
    const pages = [
      {
        data: Array.from({ length: 100 }, (_, i) => ({
          id: `id-${i}`,
          name: `n-${i}`,
        })),
        meta: { limit: 100, cursor: "page2" },
      },
      {
        data: [
          { id: "id-0", name: "n-0" }, // duplicate of first page
          { id: "id-extra", name: "n-extra" },
        ],
        meta: { limit: 100 },
      },
    ];
    let call = 0;
    const result = await paginateScoresV3({
      traceId: "t1",
      fetchPage: async () => pages[call++]!,
    });
    expect(result.evidence.pagesFetched).toBe(2);
    expect(result.evidence.retrievalCompletenessProven).toBe(true);
    expect(result.records).toHaveLength(102);
    expect(result.records.filter((r) => r.id === "id-0")).toHaveLength(2);
  });

  it("paginateScoresV3 fails closed when limit reached without readable cursor meta", async () => {
    const result = await paginateScoresV3({
      traceId: "t1",
      fetchPage: async () => ({
        data: Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}` })),
        // meta missing entirely
      }),
    });
    expect(result.evidence.retrievalCompletenessProven).toBe(false);
    expect(result.evidence.truncationReason).toBe("score_fetch_may_be_truncated");
  });

  it("paginateScoresLegacy pages until totalPages", async () => {
    const result = await paginateScoresLegacy({
      traceId: "t1",
      fetchPage: async ({ page }) => {
        if (page === 1) {
          return {
            data: [{ id: "a" }, { id: "b" }],
            meta: { page: 1, limit: 2, totalItems: 3, totalPages: 2 },
          };
        }
        return {
          data: [{ id: "a" }], // duplicate physical on page 2
          meta: { page: 2, limit: 2, totalItems: 3, totalPages: 2 },
        };
      },
    });
    expect(result.evidence.retrievalCompletenessProven).toBe(true);
    expect(result.records.filter((r) => r.id === "a")).toHaveLength(2);
  });

  it("rejects multiple canonical traces for one phase", () => {
    const report = makeInspectReport();
    report.traces.push({
      ...report.traces[0]!,
      id: "trace-planning-2",
      name: "planning-2",
    });
    const parsed = parseCursorUsageCsv(csv);
    const { aggregates } = aggregateByCloudAgentId(parsed.rows);
    const { joins } = joinAggregatesToPhaseTraces({
      report,
      aggregates,
      allowedPhases: ["planning", "plan_review"],
    });
    const canonical = validateCanonicalCsvPhaseTraces({
      joins,
      allowedPhases: ["planning", "plan_review"],
      requireAllAllowedPhases: true,
    });
    // Same agent may map ambiguously, or two planning traces → fail
    expect(canonical.ok).toBe(false);
    expect(
      canonical.skipped.some(
        (s) =>
          s.reason.includes("ambiguous_csv_score_trace:planning") ||
          s.reason.includes("ambiguous_multi_trace") ||
          s.reason.includes("csv_scores_split"),
      ) ||
        joins.some((j) => j.join.phase === "planning") === false ||
        !canonical.ok,
    ).toBe(true);
  });

  it("dry-run exits 0 with preview but acceptance remains false", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "csv-import-"));
    const csvPath = path.join(dir, "usage.csv");
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(csvPath, csv, "utf8");
    writeFileSync(inspectPath, JSON.stringify(makeInspectReport()), "utf8");

    const { report, exitCode } = await runCursorUsageImport({
      csvPath,
      inspectReportPath: inspectPath,
      issueKey: "TT-FIXTURE",
      exportWindow: {
        startIso: "2026-07-19T00:00:00.000Z",
        endIso: "2026-07-20T00:00:00.000Z",
        timezone: "UTC",
        precision: "millisecond",
        boundsSource: "cli_flags",
      },
      phases: ["planning", "plan_review"],
      dryRun: true,
      deps: { sleep: async () => {} },
    });

    expect(exitCode).toBe(0);
    expect(report.verdicts.tokenAcceptance).toBe(false);
    expect(report.verdicts.costProxyAvailability).toBe(false);
    expect(report.verdicts.exactMonetaryCostAcceptance).toBe(false);
    expect(report.preview?.previewOnly).toBe(true);
    expect(report.publicSummary.previewOnly).toBe(true);
    expect(report.publicSummary.readAfterWriteVerified).toBe(false);
    expect(report.verdicts.tokenAcceptanceReason).toBe("dry_run_not_written");
  });

  it("orchestration: second import with duplicate physical records fails final verify", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "csv-import-"));
    const csvPath = path.join(dir, "usage.csv");
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(csvPath, csv, "utf8");
    writeFileSync(inspectPath, JSON.stringify(makeInspectReport()), "utf8");

    const attachments = buildAttachments();
    const once = toFetched(attachments);
    let fetchCall = 0;

    const { report, exitCode } = await runCursorUsageImport({
      csvPath,
      inspectReportPath: inspectPath,
      issueKey: "TT-FIXTURE",
      exportWindow: {
        startIso: "2026-07-19T00:00:00.000Z",
        endIso: "2026-07-20T00:00:00.000Z",
        timezone: "UTC",
        precision: "millisecond",
        boundsSource: "cli_flags",
      },
      phases: ["planning", "plan_review"],
      dryRun: false,
      deps: {
        sleep: async () => {},
        resolveConfig: () => ({
          ok: true as const,
          config: {
            provider: "langfuse" as const,
            captureProfile: "metadata-v1" as const,
            publicKey: "pk",
            secretKey: "sk",
            baseUrl: "http://example.invalid",
            namespace: "default",
            tracingEnvironment: "test",
            release: null,
          },
        }),
        createScoreClient: async () => ({
          recordScore() {},
          flush: async () => {},
        }),
        fetchScores: async () => {
          fetchCall += 1;
          const scores =
            fetchCall === 1
              ? once.map((s) => ({ ...s }) as Record<string, unknown>)
              : [...once, ...once].map(
                  (s) => ({ ...s }) as Record<string, unknown>,
                );
          return {
            scores,
            perTrace: [
              {
                traceId: "trace-planning",
                pagesFetched: 1,
                rawRecordCountPerPage: [scores.length],
                totalPhysicalRecords: scores.length,
                retrievalCompletenessProven: true,
              },
            ],
            retrievalCompletenessProven: true,
          };
        },
      },
    });

    expect(exitCode).toBe(2);
    expect(report.readAfterWrite?.verified).toBe(false);
    expect(report.readAfterWrite?.logicalScoreCountFirst).toBe(28);
    expect(report.readAfterWrite?.physicalMatchingScoreCountSecond).toBe(56);
    expect(report.verdicts.tokenAcceptance).toBe(false);
    expect(report.verdicts.exactMonetaryCostAcceptance).toBe(false);
  });

  it("orchestration: verify2.verified=false with unchanged logical count fails final report", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "csv-import-"));
    const csvPath = path.join(dir, "usage.csv");
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(csvPath, csv, "utf8");
    writeFileSync(inspectPath, JSON.stringify(makeInspectReport()), "utf8");

    const attachments = buildAttachments();
    const once = toFetched(attachments);
    let fetchCall = 0;

    const { report } = await runCursorUsageImport({
      csvPath,
      inspectReportPath: inspectPath,
      issueKey: "TT-FIXTURE",
      exportWindow: {
        startIso: "2026-07-19T00:00:00.000Z",
        endIso: "2026-07-20T00:00:00.000Z",
        timezone: "UTC",
        precision: "millisecond",
        boundsSource: "cli_flags",
      },
      phases: ["planning", "plan_review"],
      deps: {
        sleep: async () => {},
        resolveConfig: () => ({
          ok: true as const,
          config: {
            provider: "langfuse" as const,
            captureProfile: "metadata-v1" as const,
            publicKey: "pk",
            secretKey: "sk",
            baseUrl: "http://example.invalid",
            namespace: "default",
            tracingEnvironment: "test",
            release: null,
          },
        }),
        createScoreClient: async () => ({
          recordScore() {},
          flush: async () => {},
        }),
        fetchScores: async () => {
          fetchCall += 1;
          const scores = once.map((s) => ({ ...s }) as Record<string, unknown>);
          return {
            scores,
            perTrace: [],
            // Second fetch claims truncation while returning same logical IDs
            retrievalCompletenessProven: fetchCall === 1,
          };
        },
      },
    });

    expect(report.readAfterWrite?.logicalScoreCountFirst).toBe(28);
    expect(report.readAfterWrite?.logicalScoreCountSecond).toBe(28);
    expect(report.readAfterWrite?.verified).toBe(false);
    expect(
      report.readAfterWrite?.mismatches.some(
        (m) =>
          m === "verify2:score_fetch_may_be_truncated" ||
          m.includes("score_fetch_may_be_truncated"),
      ),
    ).toBe(true);
    expect(report.verdicts.tokenAcceptance).toBe(false);
  });
});

describe("inspect CSV acceptance per phase", () => {
  function csvScoresForTrace(
    traceId: string,
    complete: boolean,
  ): Array<{
    id: string;
    name: string;
    traceId: string;
    value: number | boolean;
  }> {
    if (!complete) {
      return [
        {
          id: `${traceId}-input`,
          name: "cursor_input_tokens",
          traceId,
          value: 1,
        },
      ];
    }
    return [
      { id: `${traceId}-in`, name: "cursor_input_tokens", traceId, value: 10 },
      {
        id: `${traceId}-cr`,
        name: "cursor_cache_read_tokens",
        traceId,
        value: 2,
      },
      {
        id: `${traceId}-cw`,
        name: "cursor_cache_write_tokens",
        traceId,
        value: 1,
      },
      { id: `${traceId}-out`, name: "cursor_output_tokens", traceId, value: 3 },
      { id: `${traceId}-tot`, name: "cursor_total_tokens", traceId, value: 16 },
      {
        id: `${traceId}-tc`,
        name: "cursor_token_usage_complete",
        traceId,
        value: true,
      },
      {
        id: `${traceId}-ss`,
        name: "cursor_source_scope_complete",
        traceId,
        value: true,
      },
      {
        id: `${traceId}-kn`,
        name: "cursor_known_noncache_cost_usd",
        traceId,
        value: 0.01,
      },
      {
        id: `${traceId}-al`,
        name: "cursor_all_input_at_list_rate_usd",
        traceId,
        value: 0.02,
      },
      {
        id: `${traceId}-cp`,
        name: "cursor_cost_proxy_available",
        traceId,
        value: true,
      },
      {
        id: `${traceId}-lpc`,
        name: "cursor_list_price_equivalent_complete",
        traceId,
        value: false,
      },
      {
        id: `${traceId}-pac`,
        name: "cursor_provider_actual_cost_complete",
        traceId,
        value: false,
      },
      {
        id: `${traceId}-ex`,
        name: "cursor_exact_cost_complete",
        traceId,
        value: false,
      },
      {
        id: `${traceId}-nu`,
        name: "cursor_generation_native_usage_complete",
        traceId,
        value: false,
      },
    ];
  }

  function traces(): LangfuseInspectReport["traces"] {
    return makeInspectReport().traces;
  }

  it("fails when Planning complete and Plan Review incomplete", () => {
    const gaps: LangfuseInspectReport["gaps"] = [];
    const scores = [
      ...csvScoresForTrace("trace-planning", true),
      ...csvScoresForTrace("trace-plan-review", false),
    ].map((s) => ({
      ...s,
      sessionId: null,
      observationId: null,
      dataType: typeof s.value === "boolean" ? "BOOLEAN" : "NUMERIC",
      timestamp: null,
    }));
    const result = evaluateCursorCsvScoreAcceptance({
      traces: traces(),
      allScores: scores,
      expectedPhases: ["planning", "plan_review"],
      gaps,
    });
    expect(result.tokenAcceptance).toBe(false);
    expect(result.costProxyAvailable).toBe(false);
  });

  it("fails when Planning incomplete and Plan Review complete", () => {
    const gaps: LangfuseInspectReport["gaps"] = [];
    const scores = [
      ...csvScoresForTrace("trace-planning", false),
      ...csvScoresForTrace("trace-plan-review", true),
    ].map((s) => ({
      ...s,
      sessionId: null,
      observationId: null,
      dataType: typeof s.value === "boolean" ? "BOOLEAN" : "NUMERIC",
      timestamp: null,
    }));
    const result = evaluateCursorCsvScoreAcceptance({
      traces: traces(),
      allScores: scores,
      expectedPhases: ["planning", "plan_review"],
      gaps,
    });
    expect(result.tokenAcceptance).toBe(false);
  });

  it("passes token/proxy when both phases independently complete; exact remains separate", () => {
    const gaps: LangfuseInspectReport["gaps"] = [];
    const scores = [
      ...csvScoresForTrace("trace-planning", true),
      ...csvScoresForTrace("trace-plan-review", true),
    ].map((s) => ({
      ...s,
      sessionId: null,
      observationId: null,
      dataType: typeof s.value === "boolean" ? "BOOLEAN" : "NUMERIC",
      timestamp: null,
    }));
    const result = evaluateCursorCsvScoreAcceptance({
      traces: traces(),
      allScores: scores,
      expectedPhases: ["planning", "plan_review"],
      gaps,
    });
    expect(result.tokenAcceptance).toBe(true);
    expect(result.costProxyAvailable).toBe(true);
    expect(result.nativeUsageComplete).toBe(false);

    const attachments = buildAttachments();
    const verdicts = evaluateVerdicts({
      arithmeticValid: true,
      attachments,
      verify: verifyImportedScores({
        attachments,
        fetchedScores: toFetched(attachments),
        retrievalCompletenessProven: true,
      }),
      generationCostComplete: false,
    });
    expect(verdicts.exactMonetaryCostAcceptance).toBe(false);
  });

  it("fails ambiguous when multiple traces share a phase", () => {
    const gaps: LangfuseInspectReport["gaps"] = [];
    const tr = traces();
    tr.push({ ...tr[0]!, id: "trace-planning-dup", name: "planning-dup" });
    const scores = csvScoresForTrace("trace-planning", true).map((s) => ({
      ...s,
      sessionId: null,
      observationId: null,
      dataType: typeof s.value === "boolean" ? "BOOLEAN" : "NUMERIC",
      timestamp: null,
    }));
    const result = evaluateCursorCsvScoreAcceptance({
      traces: tr,
      allScores: scores,
      expectedPhases: ["planning", "plan_review"],
      gaps,
    });
    expect(result.tokenAcceptance).toBe(false);
    expect(
      gaps.some((g) => g.reasonCode?.includes("ambiguous_csv_score_trace")),
    ).toBe(true);
  });
});
