import type { RunManifest } from "../types/run.js";
import type {
  EvaluationCorrelation,
  EvaluationRuntime,
  EvaluationScoreInput,
  PhaseFinishSummary,
  PhaseTraceHandle,
} from "./types.js";
import type { EvaluationPhase } from "./phases.js";
import { buildMetadataV1 } from "./capture-policy.js";
import {
  readRuntimeProvenance,
  resolveRuntimeProvenanceFromProcessEnv,
  runtimeProvenanceMetadata,
} from "./runtime-provenance.js";
import { buildPhaseSuccessScore } from "./outcomes.js";
import { writeEvaluationOutcomeArtifact } from "./outcome-artifact.js";

export function phaseFinishFromManifest(
  manifest: Pick<
    RunManifest,
    | "finalOutcome"
    | "errorClassification"
    | "linearStatusAfter"
    | "prUrl"
    | "previewUrl"
    | "changedFiles"
  >,
): PhaseFinishSummary {
  return {
    finalOutcome: manifest.finalOutcome,
    errorClassification: manifest.errorClassification,
    linearStatusAfter: manifest.linearStatusAfter,
    prCreated: Boolean(manifest.prUrl),
    previewAvailable: Boolean(manifest.previewUrl),
    changedFileCount: Array.isArray(manifest.changedFiles)
      ? manifest.changedFiles.length
      : null,
  };
}

export function finishPhaseTrace(
  handle: PhaseTraceHandle | null | undefined,
  manifest: RunManifest,
  extraMetadata?: Record<string, unknown>,
): EvaluationCorrelation | null {
  if (!handle) {
    return null;
  }
  try {
    handle.finish(phaseFinishFromManifest(manifest), extraMetadata);
    return handle.correlation;
  } catch {
    return handle.correlation;
  }
}

export function withEvaluationCorrelation(
  manifest: RunManifest,
  correlation: EvaluationCorrelation | null,
): RunManifest {
  return {
    ...manifest,
    evaluation: correlation,
  };
}

/** Shared env-derived allowlisted fields for phase traces. */
export function commonEnvMetadata(
  provenance?: {
    harnessSourceCommit: string | null;
    managedRunnerCommit: string | null;
  },
): Record<string, unknown> {
  const resolved = provenance ?? resolveRuntimeProvenanceFromProcessEnv();
  return buildMetadataV1({
    githubActionsRunId: process.env.GITHUB_RUN_ID ?? null,
    githubWorkflowName: process.env.GITHUB_WORKFLOW ?? null,
    triggerType: process.env.TRIGGER ?? process.env.GITHUB_EVENT_NAME ?? null,
    githubActionsConfigFingerprint:
      process.env.HARNESS_CONFIG_FINGERPRINT ?? null,
    harnessReleaseSha: resolved.managedRunnerCommit,
    harnessSourceCommit: resolved.harnessSourceCommit,
    managedRunnerCommit: resolved.managedRunnerCommit,
    pDevPackageVersion: process.env.P_DEV_PACKAGE_VERSION ?? null,
    runGeneration: process.env.P_DEV_RUN_GENERATION
      ? Number(process.env.P_DEV_RUN_GENERATION)
      : null,
  });
}

export async function commonEnvMetadataForRun(
  runDirectory: string,
): Promise<Record<string, unknown>> {
  const captured = await readRuntimeProvenance(runDirectory);
  if (captured) {
    return buildMetadataV1({
      githubActionsRunId: process.env.GITHUB_RUN_ID ?? null,
      githubWorkflowName: process.env.GITHUB_WORKFLOW ?? null,
      triggerType: process.env.TRIGGER ?? process.env.GITHUB_EVENT_NAME ?? null,
      githubActionsConfigFingerprint:
        process.env.HARNESS_CONFIG_FINGERPRINT ?? null,
      ...runtimeProvenanceMetadata(captured),
      pDevPackageVersion: process.env.P_DEV_PACKAGE_VERSION ?? null,
      runGeneration: process.env.P_DEV_RUN_GENERATION
        ? Number(process.env.P_DEV_RUN_GENERATION)
        : null,
    });
  }
  return commonEnvMetadata();
}

export async function safeStartPhaseTrace(
  runtime: EvaluationRuntime | null | undefined,
  input: {
    phase: EvaluationPhase;
    issueKey: string;
    runId: string;
    metadata?: Record<string, unknown>;
    linearTeamKey?: string | null;
    revisionCycleIndex?: number | null;
    phaseExecutionId?: string | null;
  },
): Promise<PhaseTraceHandle | null> {
  if (!runtime) return null;
  try {
    return await runtime.startPhaseTrace({
      ...input,
      metadata: {
        ...commonEnvMetadata(),
        ...(input.metadata ?? {}),
      },
    });
  } catch {
    return null;
  }
}

export function safeRecordScore(
  runtime: EvaluationRuntime | null | undefined,
  score: EvaluationScoreInput,
): void {
  if (!runtime) return;
  try {
    runtime.recordScore(score);
  } catch {
    // Non-authoritative
  }
}

/**
 * Production-effect Langfuse projection: create + flush acknowledgement.
 * When evaluation is disabled/no-op, succeeds without network I/O.
 * Throws with langfuse_projection_failure on create/flush failure.
 */
export async function recordAcknowledgedProductionScore(
  runtime: EvaluationRuntime | null | undefined,
  score: EvaluationScoreInput,
): Promise<void> {
  if (!runtime || !runtime.enabled) {
    return;
  }
  try {
    await runtime.recordAcknowledgedScore(score);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    if (message.includes("langfuse_projection_failure")) {
      throw error instanceof Error
        ? error
        : new Error(`langfuse_projection_failure: ${message}`);
    }
    throw new Error(`langfuse_projection_failure: ${message}`);
  }
}

export function recordPhaseSuccess(
  runtime: EvaluationRuntime | null | undefined,
  correlation: EvaluationCorrelation | null,
  manifest: Pick<RunManifest, "finalOutcome" | "startedAt">,
): EvaluationScoreInput | null {
  if (!runtime || !correlation) return null;
  const score = buildPhaseSuccessScore({
    namespace: runtime.namespace,
    traceId: correlation.traceId,
    sessionId: correlation.sessionId,
    startedAt: manifest.startedAt,
    finalOutcome: manifest.finalOutcome,
  });
  safeRecordScore(runtime, score);
  return score;
}

export async function finalizePhaseEvaluation(params: {
  runtime: EvaluationRuntime | null | undefined;
  phaseTrace: PhaseTraceHandle | null;
  manifest: RunManifest;
  runDirectory: string;
  extraMetadata?: Record<string, unknown>;
  sessionScores?: EvaluationScoreInput[];
}): Promise<RunManifest> {
  const correlation = finishPhaseTrace(
    params.phaseTrace,
    params.manifest,
    params.extraMetadata,
  );
  const scores: EvaluationScoreInput[] = [];
  const phaseSuccess = recordPhaseSuccess(
    params.runtime,
    correlation,
    params.manifest,
  );
  if (phaseSuccess) {
    scores.push(phaseSuccess);
  }
  if (params.sessionScores) {
    for (const score of params.sessionScores) {
      safeRecordScore(params.runtime, score);
      scores.push(score);
    }
  }
  if (correlation && scores.length > 0) {
    try {
      await writeEvaluationOutcomeArtifact(params.runDirectory, {
        sessionId: correlation.sessionId,
        traceId: correlation.traceId,
        scores,
      });
    } catch {
      // Non-authoritative
    }
  }
  return withEvaluationCorrelation(params.manifest, correlation);
}
