import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { LangfuseInspectReport } from "../langfuse-inspect/types.js";
import {
  createLangfuseApiClient,
  fetchTraceScoresRawForImport,
  type FetchTraceScoresRawResult,
  type LangfuseApiClient,
} from "../langfuse-inspect/client.js";
import { resolveEvaluationConfig } from "../runtime.js";
import { deriveSessionId } from "../identifiers.js";
import type { EvaluationRuntimeConfig, EvaluationScoreInput } from "../types.js";
import { aggregateByCloudAgentId } from "./aggregate.js";
import {
  joinAggregatesToPhaseTraces,
  validateCanonicalCsvPhaseTraces,
  type AllowedImportPhase,
} from "./join.js";
import { digestCsvBytes, parseCursorUsageCsv, tokensSumValid } from "./parse.js";
import { computeCostProxies } from "./proxy-cost.js";
import { projectUsageScoresOnly } from "./project.js";
import { createScoreOnlyClient } from "./score-client.js";
import { attachmentFromJoin } from "./scores.js";
import {
  evaluateVerdicts,
  verifyImportedScores,
  type FetchedScore,
  type VerifyResult,
} from "./verify.js";
import {
  CURSOR_USAGE_CSV_SCHEMA_VERSION,
  CURSOR_USAGE_IMPORTER_VERSION,
  CURSOR_USAGE_SCORE_NAMES,
  type CursorUsageImportPrivateReport,
  type CursorUsageImportPublicSummary,
  type CursorUsageImportReadAfterWrite,
  type PhaseImportAttachment,
} from "./types.js";

export function mapFetchedScores(
  raw: Array<Record<string, unknown>>,
): FetchedScore[] {
  return raw.map((s) => {
    const subject = s.subject as Record<string, unknown> | undefined;
    const subjectId =
      subject && typeof subject.id === "string" ? subject.id : null;
    const subjectKind =
      subject && typeof subject.kind === "string" ? subject.kind : null;
    const traceId =
      typeof s.traceId === "string"
        ? s.traceId
        : typeof s.trace_id === "string"
          ? s.trace_id
          : typeof subject?.traceId === "string"
            ? subject.traceId
            : subjectKind === "trace"
              ? subjectId
              : null;
    return {
      id: typeof s.id === "string" ? s.id : "",
      name: typeof s.name === "string" ? s.name : "",
      traceId,
      value: s.value ?? s.stringValue ?? s.numberValue ?? null,
      dataType: typeof s.dataType === "string" ? s.dataType : null,
      timestamp:
        typeof s.timestamp === "string"
          ? s.timestamp
          : typeof s.createdAt === "string"
            ? s.createdAt
            : null,
      ...(typeof s.comment === "string" ? { comment: s.comment } : {}),
    };
  });
}

export interface CursorUsageImportDeps {
  createScoreClient?: (
    config: EvaluationRuntimeConfig,
  ) => Promise<{
    recordScore: (input: EvaluationScoreInput) => void;
    flush: () => Promise<void>;
  } | null>;
  fetchScores?: (
    client: LangfuseApiClient | null,
    sessionId: string,
    traceIds: string[],
  ) => Promise<FetchTraceScoresRawResult>;
  createApiClient?: (
    config: EvaluationRuntimeConfig,
  ) => Promise<LangfuseApiClient>;
  sleep?: (ms: number) => Promise<void>;
  resolveConfig?: typeof resolveEvaluationConfig;
}

function buildReadAfterWrite(params: {
  verify1: VerifyResult;
  verify2: VerifyResult | null;
  firstRaw: FetchTraceScoresRawResult | null;
  secondRaw: FetchTraceScoresRawResult | null;
  skipSecond: boolean;
}): { readAfterWrite: CursorUsageImportReadAfterWrite; verify: VerifyResult } {
  const { verify1, verify2, firstRaw, secondRaw, skipSecond } = params;
  const expectedCount = verify1.expectedDeterministicScoreIds.length;
  const mismatches = [
    ...verify1.mismatches,
    ...(verify2?.mismatches.map((m) => `verify2:${m}`) ?? []),
  ];
  if (
    verify2 &&
    (verify2.logicalScoreCount !== verify1.logicalScoreCount ||
      verify2.physicalMatchingScoreCount !==
        verify1.physicalMatchingScoreCount)
  ) {
    mismatches.push("second_import_count_mismatch");
  }

  const secondOk =
    skipSecond ||
    (verify2 != null &&
      verify2.verified &&
      verify2.logicalScoreCount === expectedCount &&
      verify2.physicalMatchingScoreCount === expectedCount &&
      verify2.logicalScoreCount === verify1.logicalScoreCount &&
      verify2.physicalMatchingScoreCount ===
        verify1.physicalMatchingScoreCount);

  const finalOk =
    verify1.verified &&
    verify1.logicalScoreCount === expectedCount &&
    verify1.physicalMatchingScoreCount === expectedCount &&
    secondOk &&
    mismatches.length === 0;

  const verify: VerifyResult = {
    ...verify1,
    verified: finalOk,
    mismatches: [...new Set(mismatches)],
  };

  return {
    verify,
    readAfterWrite: {
      verified: finalOk,
      logicalScoreCountFirst: verify1.logicalScoreCount,
      logicalScoreCountSecond: verify2?.logicalScoreCount ?? null,
      physicalMatchingScoreCountFirst: verify1.physicalMatchingScoreCount,
      physicalMatchingScoreCountSecond:
        verify2?.physicalMatchingScoreCount ?? null,
      uniqueMatchingDeterministicIdsFirst:
        verify1.uniqueMatchingDeterministicIds,
      uniqueMatchingDeterministicIdsSecond:
        verify2?.uniqueMatchingDeterministicIds ?? null,
      physicalRecordsMatchingExpectedTraceNameFirst:
        verify1.physicalRecordsMatchingExpectedTraceName,
      physicalRecordsMatchingExpectedTraceNameSecond:
        verify2?.physicalRecordsMatchingExpectedTraceName ?? null,
      duplicatePhysicalRecordCountFirst: verify1.duplicatePhysicalRecordCount,
      duplicatePhysicalRecordCountSecond:
        verify2?.duplicatePhysicalRecordCount ?? null,
      unrelatedPreExistingScoreCountFirst:
        verify1.unrelatedPreExistingScoreCount,
      unrelatedPreExistingScoreCountSecond:
        verify2?.unrelatedPreExistingScoreCount ?? null,
      expectedDeterministicScoreIds: verify1.expectedDeterministicScoreIds,
      retrievalCompletenessProvenFirst:
        firstRaw?.retrievalCompletenessProven === true,
      retrievalCompletenessProvenSecond: skipSecond
        ? null
        : secondRaw?.retrievalCompletenessProven === true,
      fetchEvidenceFirst: firstRaw?.perTrace,
      fetchEvidenceSecond: secondRaw?.perTrace,
      mismatches: verify.mismatches,
    },
  };
}

export async function runCursorUsageImport(options: {
  csvPath: string;
  inspectReportPath: string;
  issueKey: string;
  namespace?: string;
  phases?: string[];
  dryRun?: boolean;
  out?: string;
  publicOut?: string;
  skipSecondImportVerify?: boolean;
  deps?: CursorUsageImportDeps;
}): Promise<{
  report: CursorUsageImportPrivateReport;
  exitCode: number;
}> {
  const deps = options.deps ?? {};
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const resolveConfig = deps.resolveConfig ?? resolveEvaluationConfig;

  const issueKey = options.issueKey.trim();
  const allowedPhases = (options.phases?.length
    ? options.phases
    : ["planning", "plan_review"]) as AllowedImportPhase[];
  const dryRun = options.dryRun === true;
  const skipSecond = options.skipSecondImportVerify === true;

  const csvRaw = await readFile(options.csvPath, "utf8");
  const csvDigestSha256 = digestCsvBytes(csvRaw);
  const parsed = parseCursorUsageCsv(csvRaw);
  const inspectRaw = JSON.parse(
    await readFile(options.inspectReportPath, "utf8"),
  ) as LangfuseInspectReport;
  const namespace =
    options.namespace?.trim() ||
    inspectRaw.namespace?.trim() ||
    "default";

  const { aggregates, rejected } = aggregateByCloudAgentId(parsed.rows);
  const { joins: rawJoins, skipped: joinSkipped } = joinAggregatesToPhaseTraces(
    {
      report: inspectRaw,
      aggregates,
      allowedPhases,
    },
  );

  const canonical = validateCanonicalCsvPhaseTraces({
    joins: rawJoins,
    allowedPhases,
  });

  const skipped = [
    ...rejected.map((r) => ({
      reason: r.reason,
      cloudAgentIdHash: r.cloudAgentIdHash,
    })),
    ...joinSkipped,
    ...canonical.skipped,
  ];

  const attachments: PhaseImportAttachment[] = [];
  if (canonical.ok) {
    for (const { join, aggregate } of rawJoins) {
      if (!tokensSumValid(aggregate.tokens)) {
        skipped.push({
          reason: "aggregate_token_sum_invalid",
          cloudAgentIdHash: aggregate.cloudAgentIdHash,
          phase: join.phase,
        });
        continue;
      }
      const proxies = computeCostProxies({
        modelId: "composer-2.5",
        effectiveVariant: join.effectiveVariant,
        tokens: aggregate.tokens,
      });
      if (!proxies) {
        skipped.push({
          reason: "pricing_lookup_failed",
          cloudAgentIdHash: aggregate.cloudAgentIdHash,
          phase: join.phase,
        });
        continue;
      }
      attachments.push(
        attachmentFromJoin({
          namespace,
          join,
          aggregate,
          proxies,
        }),
      );
    }
  }

  const localArithmeticValid = parsed.arithmetic.identityHolds;
  const localAttributionValid =
    canonical.ok &&
    attachments.length === allowedPhases.length &&
    allowedPhases.every((p) => attachments.some((a) => a.join.phase === p));

  let readAfterWrite: CursorUsageImportReadAfterWrite | undefined;
  let verifyResult: VerifyResult | null = null;

  if (!dryRun && attachments.length > 0) {
    const config = resolveConfig(process.env);
    if (!config.ok) {
      skipped.push({ reason: "langfuse_runtime_unavailable" });
    } else {
      const createScore =
        deps.createScoreClient ?? ((cfg) => createScoreOnlyClient(cfg));
      const scoreClient = await createScore(config.config);
      if (!scoreClient) {
        skipped.push({ reason: "langfuse_score_client_unavailable" });
      } else {
        const allScores = attachments.flatMap((a) => a.scores);
        projectUsageScoresOnly({ recorder: scoreClient, scores: allScores });
        await scoreClient.flush();

        const sessionId =
          inspectRaw.sessionId?.trim() ||
          deriveSessionId(namespace, issueKey);
        const attachedTraceIds = attachments.map((a) => a.join.traceId);
        const expectedIds = new Set(allScores.map((s) => s.id));
        const createApi =
          deps.createApiClient ??
          ((cfg) => createLangfuseApiClient(cfg));
        const apiClient = deps.fetchScores
          ? null
          : await createApi(config.config);

        const refetchOnce = async (): Promise<FetchTraceScoresRawResult> => {
          if (deps.fetchScores) {
            return deps.fetchScores(apiClient, sessionId, attachedTraceIds);
          }
          return Promise.race([
            fetchTraceScoresRawForImport(apiClient!, attachedTraceIds),
            new Promise<FetchTraceScoresRawResult>((_, reject) =>
              setTimeout(
                () => reject(new Error("score_refetch_timeout")),
                25_000,
              ),
            ),
          ]);
        };

        /** Langfuse score index lag — retry until expected IDs appear or budget expires. */
        const refetchUntilReady = async (): Promise<FetchTraceScoresRawResult> => {
          const budgetMs = deps.fetchScores ? 0 : 20_000;
          const started = Date.now();
          let last: FetchTraceScoresRawResult | null = null;
          // Immediate attempt after a short settle; then backoff.
          await sleep(deps.fetchScores ? 0 : 2500);
          for (;;) {
            last = await refetchOnce();
            const mapped = mapFetchedScores(last.scores);
            const found = mapped.filter((s) => expectedIds.has(s.id)).length;
            if (found >= expectedIds.size || deps.fetchScores) {
              return last;
            }
            if (Date.now() - started >= budgetMs) {
              return last;
            }
            await sleep(2000);
          }
        };

        let firstRaw: FetchTraceScoresRawResult | null = null;
        let secondRaw: FetchTraceScoresRawResult | null = null;
        let verify1: VerifyResult;
        let verify2: VerifyResult | null = null;

        try {
          firstRaw = await refetchUntilReady();
          verify1 = verifyImportedScores({
            attachments,
            fetchedScores: mapFetchedScores(firstRaw.scores),
            retrievalCompletenessProven: firstRaw.retrievalCompletenessProven,
          });
        } catch (err) {
          skipped.push({
            reason: `score_refetch_failed:${
              err instanceof Error ? err.message.slice(0, 80) : "error"
            }`,
          });
          firstRaw = null;
          verify1 = verifyImportedScores({
            attachments,
            fetchedScores: [],
            retrievalCompletenessProven: false,
          });
        }

        if (!skipSecond) {
          projectUsageScoresOnly({
            recorder: scoreClient,
            scores: allScores,
          });
          await scoreClient.flush();
          try {
            secondRaw = await refetchUntilReady();
            verify2 = verifyImportedScores({
              attachments,
              fetchedScores: mapFetchedScores(secondRaw.scores),
              retrievalCompletenessProven:
                secondRaw.retrievalCompletenessProven,
            });
          } catch {
            secondRaw = {
              scores: [],
              perTrace: [],
              retrievalCompletenessProven: false,
              truncationReason: "second_import_refetch_failed",
            };
            verify2 = verifyImportedScores({
              attachments,
              fetchedScores: [],
              retrievalCompletenessProven: false,
            });
            verify2.mismatches = [
              "second_import_refetch_failed",
              ...verify2.mismatches,
            ];
          }
        }

        const built = buildReadAfterWrite({
          verify1,
          verify2,
          firstRaw,
          secondRaw,
          skipSecond,
        });
        verifyResult = built.verify;
        readAfterWrite = built.readAfterWrite;
      }
    }
  }

  const verdicts = evaluateVerdicts({
    arithmeticValid: localArithmeticValid,
    attachments,
    verify: dryRun ? null : verifyResult,
    generationCostComplete:
      inspectRaw.acceptance?.generationCostComplete === true,
    dryRun,
    localAttributionValid,
  });

  const preview = dryRun
    ? ({
        previewOnly: true as const,
        wouldAttachPhaseCount: attachments.length,
        wouldWriteScoreCount:
          attachments.length * CURSOR_USAGE_SCORE_NAMES.length,
        localArithmeticValid,
        localAttributionValid,
        readAfterWriteVerified: false as const,
      })
    : undefined;

  const publicSummary: CursorUsageImportPublicSummary = {
    schemaVersion: 1,
    kind: "cursor_usage_import_public",
    importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
    dryRun,
    ...(dryRun
      ? {
          previewOnly: true,
          localArithmeticValid,
          localAttributionValid,
          wouldAttachPhaseCount: attachments.length,
          wouldWriteScoreCount:
            attachments.length * CURSOR_USAGE_SCORE_NAMES.length,
          readAfterWriteVerified: false,
        }
      : {
          readAfterWriteVerified: readAfterWrite?.verified === true,
        }),
    arithmeticValid: localArithmeticValid,
    phasesAttached: [...new Set(attachments.map((a) => a.join.phase))],
    attachmentCount: attachments.length,
    observationMutationAttempted: false,
    tokenAcceptance: verdicts.tokenAcceptance,
    costProxyAvailability: verdicts.costProxyAvailability,
    exactMonetaryCostAcceptance: verdicts.exactMonetaryCostAcceptance,
    generationCostCompleteUnchanged: true,
  };

  const report: CursorUsageImportPrivateReport = {
    schemaVersion: 1,
    kind: "cursor_usage_import_private",
    preparedAt: new Date().toISOString(),
    importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
    csvSchemaVersion: CURSOR_USAGE_CSV_SCHEMA_VERSION,
    issueKey,
    namespace,
    csvDigestSha256,
    dryRun,
    arithmeticValid: localArithmeticValid,
    rowsParsed: parsed.rows.length,
    distinctAgents: aggregates.length,
    attachments: attachments.map((a) => ({
      phase: a.join.phase,
      traceId: a.join.traceId,
      cloudAgentIdHash: a.aggregate.cloudAgentIdHash,
      matchedRowCount: a.aggregate.rowCount,
      fingerprints: a.aggregate.fingerprints,
      tokens: a.aggregate.tokens,
      proxies: a.proxies,
      scoreIds: a.scores.map((s) => s.id),
      scoreTimestamp: a.join.traceEndTimestamp,
      attributionRationale:
        "csv_cloud_agent_id_equals_cursor_agent_id_single_allowed_phase_trace_window_fit",
      effectiveVariant: a.join.effectiveVariant,
    })),
    skipped,
    observationMutationAttempted: false,
    verdicts,
    preview,
    readAfterWrite,
    publicSummary,
  };

  if (options.out) {
    await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (options.publicOut) {
    await mkdir(path.dirname(path.resolve(options.publicOut)), {
      recursive: true,
    });
    await writeFile(
      options.publicOut,
      `${JSON.stringify(publicSummary, null, 2)}\n`,
      "utf8",
    );
  }

  const exitCode = dryRun
    ? localArithmeticValid && localAttributionValid && canonical.ok
      ? 0
      : 2
    : verdicts.tokenAcceptance && verdicts.costProxyAvailability
      ? 0
      : 2;

  return { report, exitCode };
}
