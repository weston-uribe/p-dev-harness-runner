import { mkdir, writeFile } from "node:fs/promises";
import { getEvaluatorRunReportPath } from "../../artifacts/paths.js";
import { getRubricWithHash } from "../rubrics/load.js";
import { deriveEvaluationSessionId } from "../subjects/ids.js";
import type { EvaluationSubject } from "../subjects/types.js";
import { readSubjects } from "../subjects/writer.js";
import {
  buildEvaluationContext,
  evidenceItemsForFingerprint,
} from "./context.js";
import { getExactLineageEffectiveResult } from "./effective.js";
import {
  deriveEvidenceFingerprint,
  deriveEvaluatorResultId,
} from "./ids.js";
import { errorOutcome, skippedOutcome } from "./outcomes.js";
import { loadDatasetReadinessPolicy } from "./policy.js";
import { ensureEvaluatorsRegistered } from "./register-all.js";
import {
  getTopologicalEvaluatorOrder,
  isEvaluatorApplicable,
  listRegisteredEvaluators,
} from "./registry.js";
import { commitEvaluatorResults, readEvaluatorResults } from "./store.js";
import type {
  EvaluationContext,
  EvaluatorDefinition,
  EvaluatorForcedAttempt,
  EvaluatorOutcome,
  EvaluatorPlanEntry,
  EvaluatorResult,
  EvaluatorRunReport,
} from "./types.js";
import {
  EVALUATOR_ENGINE_VERSION,
  EVALUATOR_RESULT_SCHEMA_VERSION,
} from "./types.js";

export class DeterministicEvaluatorViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeterministicEvaluatorViolation";
  }
}

export class EvaluatorEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorEngineError";
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`evaluator_timeout_${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function dependencyUnavailableOutcome(missing: string[]): EvaluatorOutcome {
  return skippedOutcome(
    "dependency_unavailable",
    "dependency_unavailable",
    `Required dependency results unavailable: ${missing.join(", ")}`,
  );
}

function resolveDependencyResults(
  definition: EvaluatorDefinition,
  existing: EvaluatorResult[],
  subjectId: string,
): { results: EvaluatorResult[]; missing: string[] } {
  const results: EvaluatorResult[] = [];
  const missing: string[] = [];
  for (const dep of definition.dependencies) {
    const any = existing
      .filter(
        (r) =>
          r.evaluationSubjectId === subjectId &&
          r.evaluatorId === dep.evaluatorId &&
          dep.acceptableVersions.includes(r.evaluatorVersion),
      )
      .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
    const lastAny = any[any.length - 1];
    if (!lastAny) {
      missing.push(`${dep.evaluatorId}@${dep.acceptableVersions.join("|")}`);
      continue;
    }
    if (lastAny.status === "pass") {
      results.push(lastAny);
      continue;
    }
    if (
      lastAny.status === "skipped" &&
      lastAny.skipReason === "not_applicable"
    ) {
      results.push(lastAny);
      continue;
    }
    if (lastAny.status === "fail") {
      missing.push(`${dep.evaluatorId}(failed)`);
      continue;
    }
    if (lastAny.status === "error") {
      missing.push(`${dep.evaluatorId}(error)`);
      continue;
    }
    missing.push(`${dep.evaluatorId}(${lastAny.skipReason ?? "skipped"})`);
  }
  return { results, missing };
}

function buildResultFromOutcome(params: {
  definition: EvaluatorDefinition;
  subject: EvaluationSubject;
  outcome: EvaluatorOutcome;
  evidenceFingerprint: string;
  rubricDefinitionHash: string;
  ctx: EvaluationContext;
  startedAt: string;
  completedAt: string;
  supersedesEvaluatorResultId?: string | null;
}): EvaluatorResult {
  const { definition, subject, outcome, ctx } = params;
  const evaluatorResultId = deriveEvaluatorResultId({
    evaluationSubjectId: subject.evaluationSubjectId,
    evaluatorId: definition.evaluatorId,
    evaluatorVersion: definition.evaluatorVersion,
    evaluatorImplementationHash: definition.implementationHash,
    rubricId: definition.rubricId,
    rubricVersion: definition.rubricVersion,
    rubricDefinitionHash: params.rubricDefinitionHash,
    dimensionId: definition.dimensionId,
    evidenceFingerprint: params.evidenceFingerprint,
  });
  const started = Date.parse(params.startedAt);
  const completed = Date.parse(params.completedAt);
  return {
    evaluatorResultSchemaVersion: EVALUATOR_RESULT_SCHEMA_VERSION,
    evaluatorResultId,
    evaluationSubjectId: subject.evaluationSubjectId,
    evaluatorId: definition.evaluatorId,
    evaluatorVersion: definition.evaluatorVersion,
    evaluatorImplementationHash: definition.implementationHash,
    rubricId: definition.rubricId,
    rubricVersion: definition.rubricVersion,
    rubricDefinitionHash: params.rubricDefinitionHash,
    dimensionId: definition.dimensionId,
    status: outcome.status,
    result: outcome.result ?? null,
    skipReason: outcome.skipReason ?? null,
    reasonCode: outcome.reasonCode,
    evidenceReferences: outcome.evidenceReferences ?? [],
    missingEvidence: outcome.missingEvidence ?? [],
    untrustedEvidence: outcome.untrustedEvidence ?? [],
    explanation: outcome.explanation.slice(0, 2000),
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    executionDurationMs: Number.isFinite(completed - started)
      ? Math.max(0, completed - started)
      : 0,
    engineVersion: EVALUATOR_ENGINE_VERSION,
    sourceHarnessRelease: subject.sourceHarnessRelease,
    sourceHarnessCommit: subject.sourceHarnessCommit,
    evaluationPolicyVersion: ctx.evaluationPolicyVersion,
    evaluationPolicyHash: ctx.evaluationPolicyHash,
    evidenceFingerprint: params.evidenceFingerprint,
    supersedesEvaluatorResultId: params.supersedesEvaluatorResultId ?? null,
    workflowStateMachineVersion: outcome.workflowStateMachineVersion ?? null,
    workflowStateMachineHash: outcome.workflowStateMachineHash ?? null,
  };
}

function outcomesEquivalent(
  a: Pick<
    EvaluatorResult,
    "status" | "result" | "reasonCode" | "evidenceFingerprint"
  >,
  b: Pick<
    EvaluatorResult,
    "status" | "result" | "reasonCode" | "evidenceFingerprint"
  >,
): boolean {
  return (
    a.status === b.status &&
    a.result === b.result &&
    a.reasonCode === b.reasonCode &&
    a.evidenceFingerprint === b.evidenceFingerprint
  );
}

function tally(
  counts: EvaluatorRunReport["counts"],
  result: EvaluatorResult,
): void {
  counts[result.status] += 1;
  if (result.status === "skipped") {
    if (result.skipReason === "not_applicable") counts.skippedNotApplicable += 1;
    if (result.skipReason === "insufficient_evidence") {
      counts.skippedInsufficientEvidence += 1;
    }
    if (result.skipReason === "dependency_unavailable") {
      counts.skippedDependencyUnavailable += 1;
    }
  }
}

function uniqueEvaluators(
  plan: EvaluatorPlanEntry[],
): EvaluatorRunReport["evaluatorsSelected"] {
  const seen = new Set<string>();
  const out: EvaluatorRunReport["evaluatorsSelected"] = [];
  for (const p of plan) {
    const k = `${p.evaluatorId}@${p.evaluatorVersion}:${p.dimensionId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      evaluatorId: p.evaluatorId,
      evaluatorVersion: p.evaluatorVersion,
      dimensionId: p.dimensionId,
    });
  }
  return out;
}

export async function planEvaluations(params: {
  evaluationDirectory: string;
  issueKey: string;
  namespace?: string;
  subjectId?: string;
  subjectType?: string;
  phase?: string;
  evaluatorId?: string;
  rubricId?: string;
}): Promise<{
  plan: EvaluatorPlanEntry[];
  policyVersion: string;
  policyHash: string;
}> {
  await ensureEvaluatorsRegistered();
  const { policy, policyHash } = await loadDatasetReadinessPolicy();
  const subjects = await readSubjects(params.evaluationDirectory);
  const filtered = subjects.filter((s) => {
    if (params.subjectId && s.evaluationSubjectId !== params.subjectId) {
      return false;
    }
    if (params.subjectType && s.subjectType !== params.subjectType) {
      return false;
    }
    if (params.phase && s.phase !== params.phase) return false;
    return true;
  });
  const defs = listRegisteredEvaluators().filter((d) => {
    if (params.evaluatorId && d.evaluatorId !== params.evaluatorId) {
      return false;
    }
    if (params.rubricId && d.rubricId !== params.rubricId) return false;
    return true;
  });
  const plan: EvaluatorPlanEntry[] = [];
  for (const subject of filtered) {
    for (const definition of defs) {
      if (
        !isEvaluatorApplicable({
          definition,
          subjectType: subject.subjectType,
          phase: subject.phase,
        })
      ) {
        continue;
      }
      plan.push({
        evaluationSubjectId: subject.evaluationSubjectId,
        subjectType: subject.subjectType,
        phase: subject.phase,
        evaluatorId: definition.evaluatorId,
        evaluatorVersion: definition.evaluatorVersion,
        dimensionId: definition.dimensionId,
        rubricId: definition.rubricId,
        rubricVersion: definition.rubricVersion,
        reason: "applicable",
      });
    }
  }
  plan.sort((a, b) => {
    const s = a.evaluationSubjectId.localeCompare(b.evaluationSubjectId);
    if (s !== 0) return s;
    const e = a.evaluatorId.localeCompare(b.evaluatorId);
    if (e !== 0) return e;
    return a.dimensionId.localeCompare(b.dimensionId);
  });
  return {
    plan,
    policyVersion: policy.policyVersion,
    policyHash,
  };
}

type WorkItem = {
  subject: EvaluationSubject;
  definition: EvaluatorDefinition;
};

async function evaluateOneItem(params: {
  item: WorkItem;
  subjects: EvaluationSubject[];
  workingResults: EvaluatorResult[];
  logDirectory: string;
  issueKey: string;
  evaluationDirectory: string;
  policyVersion: string;
  policyHash: string;
  force: boolean;
  timeoutMs: number;
  now: () => string;
}): Promise<
  | { kind: "reuse"; result: EvaluatorResult }
  | { kind: "append"; result: EvaluatorResult }
  | { kind: "forced_reuse"; result: EvaluatorResult; attempt: EvaluatorForcedAttempt }
> {
  const { item } = params;
  const evalStarted = params.now();
  const rubricLoaded = await getRubricWithHash(
    item.definition.rubricId,
    item.definition.rubricVersion,
  );
  if (!rubricLoaded) {
    throw new EvaluatorEngineError(
      `Rubric not found: ${item.definition.rubricId}@${item.definition.rubricVersion}`,
    );
  }
  if (rubricLoaded.rubric.judgmentChannel !== "machine") {
    throw new EvaluatorEngineError(
      `Evaluator bound to non-machine rubric: ${item.definition.rubricId}`,
    );
  }

  const { results: depResults, missing } = resolveDependencyResults(
    item.definition,
    params.workingResults,
    item.subject.evaluationSubjectId,
  );

  const ctx = await buildEvaluationContext({
    subject: item.subject,
    sessionSubjects: params.subjects,
    definition: item.definition,
    logDirectory: params.logDirectory,
    issueKey: params.issueKey,
    evaluationDirectory: params.evaluationDirectory,
    dependencyResults: depResults,
    rubricDefinitionHash: rubricLoaded.rubricDefinitionHash,
    evaluationPolicyVersion: params.policyVersion,
    evaluationPolicyHash: params.policyHash,
    now: params.now,
  });

  const evidenceFingerprint = deriveEvidenceFingerprint({
    evidenceItems: evidenceItemsForFingerprint(item.definition, ctx.evidence),
    dependencyResultIds: depResults.map((r) => r.evaluatorResultId),
    subjectSchemaVersion: item.subject.evaluationSubjectSchemaVersion,
    rubricDefinitionHash: rubricLoaded.rubricDefinitionHash,
    evaluatorImplementationHash: item.definition.implementationHash,
  });

  const priorLineage = getExactLineageEffectiveResult(params.workingResults, {
    evaluationSubjectId: item.subject.evaluationSubjectId,
    evaluatorId: item.definition.evaluatorId,
    evaluatorVersion: item.definition.evaluatorVersion,
    evaluatorImplementationHash: item.definition.implementationHash,
    rubricId: item.definition.rubricId,
    rubricVersion: item.definition.rubricVersion,
    rubricDefinitionHash: rubricLoaded.rubricDefinitionHash,
    dimensionId: item.definition.dimensionId,
  });

  const resultId = deriveEvaluatorResultId({
    evaluationSubjectId: item.subject.evaluationSubjectId,
    evaluatorId: item.definition.evaluatorId,
    evaluatorVersion: item.definition.evaluatorVersion,
    evaluatorImplementationHash: item.definition.implementationHash,
    rubricId: item.definition.rubricId,
    rubricVersion: item.definition.rubricVersion,
    rubricDefinitionHash: rubricLoaded.rubricDefinitionHash,
    dimensionId: item.definition.dimensionId,
    evidenceFingerprint,
  });

  const existingSameId = params.workingResults.find(
    (r) => r.evaluatorResultId === resultId,
  );

  if (existingSameId && !params.force) {
    return { kind: "reuse", result: existingSameId };
  }

  let outcome: EvaluatorOutcome;
  if (missing.length > 0) {
    outcome = dependencyUnavailableOutcome(missing);
  } else {
    outcome = await withTimeout(
      Promise.resolve(item.definition.evaluate(ctx)),
      params.timeoutMs,
    ).catch((error) =>
      errorOutcome(
        error instanceof Error && error.message.startsWith("evaluator_timeout")
          ? "evaluator_timeout"
          : "evaluator_threw",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  const evalCompleted = params.now();
  const candidate = buildResultFromOutcome({
    definition: item.definition,
    subject: item.subject,
    outcome,
    evidenceFingerprint,
    rubricDefinitionHash: rubricLoaded.rubricDefinitionHash,
    ctx,
    startedAt: evalStarted,
    completedAt: evalCompleted,
    supersedesEvaluatorResultId:
      priorLineage &&
      priorLineage.evaluatorResultId !== resultId &&
      priorLineage.evidenceFingerprint !== evidenceFingerprint
        ? priorLineage.evaluatorResultId
        : null,
  });

  if (params.force && existingSameId) {
    if (outcomesEquivalent(existingSameId, candidate)) {
      return {
        kind: "forced_reuse",
        result: existingSameId,
        attempt: {
          evaluatorResultId: existingSameId.evaluatorResultId,
          evaluationSubjectId: item.subject.evaluationSubjectId,
          evaluatorId: item.definition.evaluatorId,
          outcome: "reused_equivalent",
          detail: "Forced re-execution produced equivalent result.",
        },
      };
    }
    throw new DeterministicEvaluatorViolation(
      `Forced evaluation changed outcome for ${existingSameId.evaluatorResultId}: stored=${existingSameId.status}/${String(existingSameId.result)}/${existingSameId.reasonCode} candidate=${candidate.status}/${String(candidate.result)}/${candidate.reasonCode}`,
    );
  }

  return { kind: "append", result: candidate };
}

export async function runEvaluations(params: {
  logDirectory: string;
  evaluationDirectory: string;
  issueKey: string;
  namespace?: string;
  subjectId?: string;
  subjectType?: string;
  phase?: string;
  evaluatorId?: string;
  rubricId?: string;
  dryRun?: boolean;
  force?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  now?: () => string;
}): Promise<EvaluatorRunReport> {
  const now = params.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const namespace =
    params.namespace ?? process.env.P_DEV_EVALUATION_NAMESPACE ?? "default";
  const evaluationSessionId = deriveEvaluationSessionId(
    namespace,
    params.issueKey,
  );

  await ensureEvaluatorsRegistered();
  const topo = getTopologicalEvaluatorOrder();
  const { policy, policyHash } = await loadDatasetReadinessPolicy();
  const subjects = await readSubjects(params.evaluationDirectory);
  if (subjects.length === 0) {
    throw new EvaluatorEngineError("No subjects in evaluation store");
  }

  const { plan } = await planEvaluations(params);

  if (params.dryRun) {
    return {
      schemaVersion: 1,
      engineVersion: EVALUATOR_ENGINE_VERSION,
      evaluationPolicyVersion: policy.policyVersion,
      evaluationPolicyHash: policyHash,
      issueKey: params.issueKey,
      evaluationSessionId,
      startedAt,
      completedAt: now(),
      dryRun: true,
      subjectsConsidered: [...new Set(plan.map((p) => p.evaluationSubjectId))],
      evaluatorsSelected: uniqueEvaluators(plan),
      resultsAppended: 0,
      resultsReused: 0,
      forcedAttempts: [],
      counts: {
        pass: 0,
        fail: 0,
        skipped: 0,
        error: 0,
        skippedNotApplicable: 0,
        skippedInsufficientEvidence: 0,
        skippedDependencyUnavailable: 0,
      },
      missingEvidenceSummary: {},
      untrustedEvidenceSummary: {},
      durationByEvaluator: {},
      warnings: ["dry_run"],
    };
  }

  const existing = await readEvaluatorResults(params.evaluationDirectory);
  const workingResults = [...existing];
  const warnings: string[] = [];
  const forcedAttempts: EvaluatorForcedAttempt[] = [];
  const durationByEvaluator: Record<string, number> = {};
  const missingEvidenceSummary: Record<string, number> = {};
  const untrustedEvidenceSummary: Record<string, number> = {};
  let resultsReused = 0;
  const counts: EvaluatorRunReport["counts"] = {
    pass: 0,
    fail: 0,
    skipped: 0,
    error: 0,
    skippedNotApplicable: 0,
    skippedInsufficientEvidence: 0,
    skippedDependencyUnavailable: 0,
  };

  const concurrency = Math.max(1, params.concurrency ?? 1);
  const timeoutMs = params.timeoutMs ?? 30_000;
  const defByKey = new Map(
    listRegisteredEvaluators().map((d) => [
      `${d.evaluatorId}@${d.evaluatorVersion}`,
      d,
    ]),
  );

  const remaining: WorkItem[] = [];
  for (const entry of plan) {
    const subject = subjects.find(
      (s) => s.evaluationSubjectId === entry.evaluationSubjectId,
    );
    const definition = defByKey.get(
      `${entry.evaluatorId}@${entry.evaluatorVersion}`,
    );
    if (subject && definition) remaining.push({ subject, definition });
  }

  const candidatesToCommit: EvaluatorResult[] = [];
  const completedKeys = new Set<string>();

  while (remaining.length > 0) {
    const ready: WorkItem[] = [];
    const blocked: WorkItem[] = [];
    for (const item of remaining) {
      const depsStillPending = remaining.some(
        (p) =>
          p !== item &&
          p.subject.evaluationSubjectId === item.subject.evaluationSubjectId &&
          item.definition.dependencies.some(
            (d) =>
              d.evaluatorId === p.definition.evaluatorId &&
              d.acceptableVersions.includes(p.definition.evaluatorVersion),
          ),
      );
      if (depsStillPending) blocked.push(item);
      else ready.push(item);
    }

    if (ready.length === 0) {
      ready.push(...blocked);
      blocked.length = 0;
      warnings.push("evaluator_dependency_wave_stuck");
    }

    ready.sort((a, b) => {
      const s = a.subject.evaluationSubjectId.localeCompare(
        b.subject.evaluationSubjectId,
      );
      if (s !== 0) return s;
      const ai = topo.indexOf(
        `${a.definition.evaluatorId}@${a.definition.evaluatorVersion}`,
      );
      const bi = topo.indexOf(
        `${b.definition.evaluatorId}@${b.definition.evaluatorVersion}`,
      );
      if (ai !== bi) return ai - bi;
      return a.definition.dimensionId.localeCompare(b.definition.dimensionId);
    });

    for (let i = 0; i < ready.length; i += concurrency) {
      const batch = ready.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((item) =>
          evaluateOneItem({
            item,
            subjects,
            workingResults,
            logDirectory: params.logDirectory,
            issueKey: params.issueKey,
            evaluationDirectory: params.evaluationDirectory,
            policyVersion: policy.policyVersion,
            policyHash,
            force: Boolean(params.force),
            timeoutMs,
            now,
          }),
        ),
      );

      for (const item of batchResults) {
        if (item.kind === "reuse" || item.kind === "forced_reuse") {
          resultsReused += 1;
          tally(counts, item.result);
          if (item.kind === "forced_reuse") {
            forcedAttempts.push(item.attempt);
          }
        } else {
          candidatesToCommit.push(item.result);
          workingResults.push(item.result);
          tally(counts, item.result);
          durationByEvaluator[item.result.evaluatorId] =
            (durationByEvaluator[item.result.evaluatorId] ?? 0) +
            item.result.executionDurationMs;
          for (const m of item.result.missingEvidence) {
            missingEvidenceSummary[m] = (missingEvidenceSummary[m] ?? 0) + 1;
          }
          for (const u of item.result.untrustedEvidence) {
            untrustedEvidenceSummary[u] =
              (untrustedEvidenceSummary[u] ?? 0) + 1;
          }
        }
      }
    }

    for (const item of ready) {
      completedKeys.add(
        `${item.subject.evaluationSubjectId}:${item.definition.evaluatorId}@${item.definition.evaluatorVersion}:${item.definition.dimensionId}`,
      );
    }
    remaining.length = 0;
    for (const item of blocked) {
      const key = `${item.subject.evaluationSubjectId}:${item.definition.evaluatorId}@${item.definition.evaluatorVersion}:${item.definition.dimensionId}`;
      if (!completedKeys.has(key)) remaining.push(item);
    }
  }

  const commit = await commitEvaluatorResults({
    evaluationDirectory: params.evaluationDirectory,
    existing,
    candidates: candidatesToCommit,
  });

  const report: EvaluatorRunReport = {
    schemaVersion: 1,
    engineVersion: EVALUATOR_ENGINE_VERSION,
    evaluationPolicyVersion: policy.policyVersion,
    evaluationPolicyHash: policyHash,
    issueKey: params.issueKey,
    evaluationSessionId,
    startedAt,
    completedAt: now(),
    dryRun: false,
    subjectsConsidered: [...new Set(plan.map((p) => p.evaluationSubjectId))],
    evaluatorsSelected: uniqueEvaluators(plan),
    resultsAppended: commit.appended.length,
    resultsReused: resultsReused + commit.reusedIds.length,
    forcedAttempts,
    counts,
    missingEvidenceSummary,
    untrustedEvidenceSummary,
    durationByEvaluator,
    warnings,
  };

  await mkdir(params.evaluationDirectory, { recursive: true });
  await writeFile(
    getEvaluatorRunReportPath(params.evaluationDirectory),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}

export { listRegisteredEvaluators } from "./registry.js";
