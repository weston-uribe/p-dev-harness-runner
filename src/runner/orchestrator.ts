import { executeDryRun } from "./dry-run.js";
import { executeHandoffPhase } from "./phases/handoff.js";
import { executeMergePhase } from "./phases/merge.js";
import { executeRevisionPhase } from "./phases/revision.js";
import { executeImplementationPhase } from "./phases/implementation.js";
import { executePlanningPhase } from "./phases/planning.js";
import { executePlanReviewPhase } from "./phases/plan-review.js";
import { executeCodeReviewPhase } from "./phases/code-review.js";
import { executeCodeRevisionPhase } from "./phases/code-revision.js";
import { fetchLinearIssue } from "../linear/client.js";
import { inferPhaseFromStatus } from "./phase-infer.js";
import { loadHarnessConfig } from "../config/load-config.js";
import { EXIT_CONFIG } from "../cli/exit-codes.js";
import type { RunManifest } from "../types/run.js";
import type { EvaluationRuntime } from "../evaluation/types.js";

export function shouldContinueToImplementationAfterPlanning(
  manifest: RunManifest,
): boolean {
  if (
    manifest.linearStatusAfter &&
    manifest.linearStatusAfter.trim().toLowerCase() === "canceled"
  ) {
    return false;
  }
  // When Plan Review is effectively enabled, planning lands on Plan Review — do not auto-build.
  if (
    manifest.linearStatusAfter &&
    manifest.linearStatusAfter.trim().toLowerCase() === "plan review"
  ) {
    return false;
  }
  return manifest.finalOutcome === "success";
}

export function shouldContinueToHandoffAfterImplementation(
  manifest: RunManifest,
): boolean {
  return (
    (manifest.finalOutcome === "success" && manifest.phase === "implementation") ||
    (manifest.finalOutcome === "duplicate" &&
      manifest.errorClassification === "recovery_handoff")
  );
}

async function continueAfterImplementation(
  options: OrchestratorOptions,
  implResult: { exitCode: number; runDirectory?: string; manifest?: unknown },
): Promise<{ exitCode: number; runDirectory?: string; manifest?: unknown }> {
  const manifest = implResult.manifest as RunManifest | undefined;
  if (!manifest || !shouldContinueToHandoffAfterImplementation(manifest)) {
    return implResult;
  }

  const handoffResult = await executeHandoffPhase({
    issueKey: options.issueKey,
    configPath: options.configPath,
    force: options.force,
    evaluationRuntime: options.evaluationRuntime,
  });
  return {
    exitCode: handoffResult.exitCode,
    runDirectory: handoffResult.runDirectory,
    manifest: handoffResult.manifest,
  };
}

export type { RunPhaseArg } from "./phase-args.js";
import type { RunPhaseArg } from "./phase-args.js";

export interface OrchestratorOptions {
  issueKey: string;
  configPath: string;
  dryRun?: boolean;
  fixturePath?: string;
  phase?: RunPhaseArg;
  force?: boolean;
  evaluationRuntime?: EvaluationRuntime;
}

export async function runOrchestrator(
  options: OrchestratorOptions,
): Promise<{ exitCode: number; runDirectory?: string; manifest?: unknown }> {
  if (options.dryRun || options.phase === "dry-run") {
    const result = await executeDryRun({
      issueKey: options.issueKey,
      configPath: options.configPath,
      fixturePath: options.fixturePath,
    });
    return {
      exitCode: result.exitCode,
      runDirectory: result.runDirectory,
      manifest: result.manifest,
    };
  }

  if (options.fixturePath) {
    console.error("--fixture is only supported with --dry-run");
    return { exitCode: EXIT_CONFIG };
  }

  let phase = options.phase ?? "auto";
  if (phase === "auto") {
    const linearApiKey = process.env.LINEAR_API_KEY;
    if (!linearApiKey) {
      console.error("LINEAR_API_KEY is required for live runs");
      return { exitCode: EXIT_CONFIG };
    }
    const { config } = await loadHarnessConfig({ configPath: options.configPath });
    const issue = await fetchLinearIssue(options.issueKey, linearApiKey);
    const inferred = inferPhaseFromStatus(issue.status, config);
    if (inferred.phase === "planning") {
      phase = "planning";
    } else if (inferred.phase === "plan_review") {
      phase = "plan_review";
    } else if (inferred.phase === "handoff") {
      phase = "handoff";
    } else if (inferred.phase === "code_review") {
      phase = "code_review";
    } else if (inferred.phase === "code_revision") {
      phase = "code_revision";
    } else if (inferred.phase === "revision") {
      phase = "revision";
    } else if (inferred.phase === "merge") {
      phase = "merge";
    } else if (inferred.phase === "implementation") {
      phase = "implementation";
    } else {
      console.error(
        `Issue status "${issue.status ?? "unknown"}" is not eligible for harness run`,
      );
      return { exitCode: EXIT_CONFIG };
    }
  }

  if (phase === "plan_review") {
    const result = await executePlanReviewPhase({
      issueKey: options.issueKey,
      configPath: options.configPath,
      force: options.force,
      evaluationRuntime: options.evaluationRuntime,
    });
    return {
      exitCode: result.exitCode,
      runDirectory: result.runDirectory,
      manifest: result.manifest,
    };
  }

  if (phase === "code_review") {
    const result = await executeCodeReviewPhase({
      issueKey: options.issueKey,
      configPath: options.configPath,
      force: options.force,
      evaluationRuntime: options.evaluationRuntime,
    });
    return {
      exitCode: result.exitCode,
      runDirectory: result.runDirectory,
      manifest: result.manifest,
    };
  }

  if (phase === "code_revision") {
    const result = await executeCodeRevisionPhase({
      issueKey: options.issueKey,
      configPath: options.configPath,
      force: options.force,
      evaluationRuntime: options.evaluationRuntime,
    });
    return {
      exitCode: result.exitCode,
      runDirectory: result.runDirectory,
      manifest: result.manifest,
    };
  }

  if (phase === "planning") {
    const result = await executePlanningPhase({
      issueKey: options.issueKey,
      configPath: options.configPath,
      force: options.force,
      evaluationRuntime: options.evaluationRuntime,
    });
    if (shouldContinueToImplementationAfterPlanning(result.manifest)) {
      const implResult = await executeImplementationPhase({
        issueKey: options.issueKey,
        configPath: options.configPath,
        force: options.force,
        evaluationRuntime: options.evaluationRuntime,
      });
      return continueAfterImplementation(options, implResult);
    }
    return {
      exitCode: result.exitCode,
      runDirectory: result.runDirectory,
      manifest: result.manifest,
    };
  }

  if (phase === "implementation") {
    const result = await executeImplementationPhase({
      issueKey: options.issueKey,
      configPath: options.configPath,
      force: options.force,
      evaluationRuntime: options.evaluationRuntime,
    });
    return continueAfterImplementation(options, result);
  }

  if (phase === "handoff") {
    const result = await executeHandoffPhase({
      issueKey: options.issueKey,
      configPath: options.configPath,
      force: options.force,
      evaluationRuntime: options.evaluationRuntime,
    });
    return {
      exitCode: result.exitCode,
      runDirectory: result.runDirectory,
      manifest: result.manifest,
    };
  }

  if (phase === "revision") {
    const result = await executeRevisionPhase({
      issueKey: options.issueKey,
      configPath: options.configPath,
      force: options.force,
      evaluationRuntime: options.evaluationRuntime,
    });
    return {
      exitCode: result.exitCode,
      runDirectory: result.runDirectory,
      manifest: result.manifest,
    };
  }

  if (phase === "merge") {
    const result = await executeMergePhase({
      issueKey: options.issueKey,
      configPath: options.configPath,
      force: options.force,
      evaluationRuntime: options.evaluationRuntime,
    });
    return {
      exitCode: result.exitCode,
      runDirectory: result.runDirectory,
      manifest: result.manifest,
    };
  }

  console.error(`Unsupported phase: ${phase}`);
  return { exitCode: EXIT_CONFIG };
}
