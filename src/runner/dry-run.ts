import { MILESTONE } from "../config/defaults.js";
import { emptyMergeManifestFields } from "../artifacts/manifest-fields.js";
import { writeManifest } from "../artifacts/manifest.js";
import { writeRunSummary } from "../artifacts/summary.js";
import { resolveModelId } from "../agents/index.js";
import { runPreflight } from "./preflight.js";
import type { RunManifest } from "../types/run.js";

export interface DryRunOptions {
  issueKey: string;
  configPath: string;
  fixturePath?: string;
}

export interface DryRunResult {
  manifest: RunManifest;
  runDirectory: string;
  exitCode: number;
}

export async function executeDryRun(options: DryRunOptions): Promise<DryRunResult> {
  const preflight = await runPreflight({
    issueKey: options.issueKey,
    configPath: options.configPath,
    fixturePath: options.fixturePath,
    linearApiKey: process.env.LINEAR_API_KEY,
  });

  const finishedAt = new Date().toISOString();
  const model =
    preflight.success && preflight.context.config
      ? resolveModelId(preflight.context.config)
      : !preflight.success && preflight.config
        ? resolveModelId(preflight.config)
        : null;

  if (preflight.success) {
    const manifest: RunManifest = {
      runId: preflight.context.runId,
      issueKey: options.issueKey,
      phase: preflight.context.phase,
      phaseInferredFromStatus: preflight.context.phaseInferredFromStatus,
      linearStatusBefore: preflight.context.issue.status,
      linearStatusAfter: preflight.context.issue.status,
      targetRepo: preflight.context.resolved.targetRepo,
      baseBranch: preflight.context.resolved.baseBranch,
      resolutionSource: preflight.context.resolved.resolutionSource,
      dryRun: true,
      finalOutcome: "success",
      errorClassification: null,
      startedAt: preflight.context.startedAt.toISOString(),
      finishedAt,
      milestone: MILESTONE,
      promptVersion: null,
      cursorAgentId: null,
      cursorRunId: null,
      branch: null,
      prUrl: null,
      previewUrl: null,
      validationSummary: null,
      changedFiles: null,
      checkSummary: null,
      previousImplementationRunId: null,
      previousHandoffRunId: null,
      pmFeedbackCommentId: null,
      ...emptyMergeManifestFields(),
      model,
    };
    await writeManifest(preflight.context.runDirectory, manifest);
    await writeRunSummary(
      preflight.context.runDirectory,
      manifest,
      preflight.context.parsed,
      preflight.context.resolved,
    );
    await preflight.context.events.log("run_finished", "info", {
      finalOutcome: "success",
    });
    return {
      manifest,
      runDirectory: preflight.context.runDirectory,
      exitCode: 0,
    };
  }

  const manifest: RunManifest = {
    runId: preflight.runId,
    issueKey: options.issueKey,
    phase: preflight.phase,
    phaseInferredFromStatus: preflight.phaseInferredFromStatus,
    linearStatusBefore: preflight.issue?.status ?? null,
    linearStatusAfter: preflight.issue?.status ?? null,
    targetRepo: preflight.resolved?.targetRepo ?? null,
    baseBranch: preflight.resolved?.baseBranch ?? null,
    resolutionSource: preflight.resolved?.resolutionSource ?? null,
    dryRun: true,
    finalOutcome: "failed",
    errorClassification: preflight.errorClassification,
    startedAt: preflight.startedAt.toISOString(),
    finishedAt,
    milestone: MILESTONE,
    promptVersion: null,
    cursorAgentId: null,
    cursorRunId: null,
    branch: null,
    prUrl: null,
    previewUrl: null,
    validationSummary: null,
    changedFiles: null,
    checkSummary: null,
    previousImplementationRunId: null,
    previousHandoffRunId: null,
    pmFeedbackCommentId: null,
    ...emptyMergeManifestFields(),
    model,
  };

  if (preflight.runDirectory) {
    await writeManifest(preflight.runDirectory, manifest);
    await writeRunSummary(
      preflight.runDirectory,
      manifest,
      preflight.parsed,
      preflight.resolved,
    );
    await preflight.events?.log("run_finished", "error", {
      finalOutcome: "failed",
      errorClassification: preflight.errorClassification,
    });
  }

  return {
    manifest,
    runDirectory: preflight.runDirectory,
    exitCode: 2,
  };
}
