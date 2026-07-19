import { EXIT_CONFIG } from "../exit-codes.js";
import {
  buildFallbackRunManifest,
  writeJsonOutManifest,
} from "../../artifacts/write-json-out-manifest.js";
import { PublicSafeLogger } from "../../public-execution/logger.js";
import { isPublicRunnerMode } from "../../public-execution/mode.js";
import { resolveRunGeneration } from "../../runner/run-generation.js";
import { runOrchestrator, type RunPhaseArg } from "../../runner/orchestrator.js";
import { createEvaluationRuntime } from "../../evaluation/runtime.js";
import type { RunManifest } from "../../types/run.js";
import { resolveIssueKeyFromRequestId } from "./claim-job-request.js";

export interface RunCommandOptions {
  issueKey?: string;
  requestId?: string;
  configPath: string;
  dryRun?: boolean;
  fixturePath?: string;
  json?: boolean;
  jsonOut?: string;
  phase?: RunPhaseArg;
  force?: boolean;
}

async function writeRunJsonOut(
  jsonOut: string,
  manifest: RunManifest,
): Promise<void> {
  await writeJsonOutManifest(jsonOut, manifest);
}

export async function runRunCommand(options: RunCommandOptions): Promise<number> {
  const requestId = options.requestId?.trim();
  const issueKeyInput = options.issueKey?.trim();
  if (!requestId && !issueKeyInput) {
    console.error("Either --request-id or --issue <KEY> is required.");
    return EXIT_CONFIG;
  }
  if (requestId && issueKeyInput) {
    console.error("Use only one of --request-id or --issue.");
    return EXIT_CONFIG;
  }

  let issueKey: string;
  try {
    issueKey = requestId
      ? await resolveIssueKeyFromRequestId(requestId)
      : issueKeyInput!;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }

  if (options.fixturePath && !options.dryRun && options.phase !== "dry-run") {
    console.error("--fixture is only supported with --dry-run");
    return EXIT_CONFIG;
  }

  const deliveryId = process.env.LINEAR_DELIVERY_ID ?? null;
  const runGeneration = resolveRunGeneration();
  const evaluationRuntime = await createEvaluationRuntime();

  let result: { exitCode: number; runDirectory?: string; manifest?: unknown };
  try {
    try {
      result = await runOrchestrator({
        issueKey,
        configPath: options.configPath,
        dryRun: options.dryRun,
        fixturePath: options.fixturePath,
        phase: options.dryRun ? "dry-run" : options.phase,
        force: options.force,
        evaluationRuntime,
      });
    } catch (error) {
      if (options.jsonOut) {
        const fallback = buildFallbackRunManifest({
          issueKey,
          errorClassification: "run_crash",
          message: error instanceof Error ? error.message : String(error),
          deliveryId,
          runGeneration,
        });
        await writeRunJsonOut(options.jsonOut, fallback);
      }
      throw error;
    }

    const manifest = result.manifest as RunManifest | undefined;

    if (options.jsonOut) {
      if (manifest) {
        await writeRunJsonOut(options.jsonOut, {
          ...manifest,
          deliveryId: manifest.deliveryId ?? deliveryId,
          runGeneration: manifest.runGeneration ?? runGeneration,
        });
      } else {
        const fallback = buildFallbackRunManifest({
          issueKey,
          errorClassification: "run_crash",
          message: "Harness run finished without a manifest",
          deliveryId,
          runGeneration,
        });
        await writeRunJsonOut(options.jsonOut, fallback);
      }
    }

    if (isPublicRunnerMode()) {
      new PublicSafeLogger().log({
        requestId: requestId ?? undefined,
        phase: manifest?.phase,
        outcome: result.exitCode === 0 ? "success" : "failure",
        errorCode: manifest?.errorClassification ?? undefined,
      });
    } else if (options.json && manifest) {
      console.log(JSON.stringify(manifest, null, 2));
    } else if (manifest && typeof manifest === "object") {
      const label = manifest.dryRun ? "Dry run" : "Run";
      console.log(`${label} finished: ${manifest.finalOutcome}`);
      if (result.runDirectory) {
        console.log(`Run directory: ${result.runDirectory}`);
      }
      if (manifest.errorClassification) {
        console.log(`Error classification: ${manifest.errorClassification}`);
      }
    }

    return result.exitCode;
  } finally {
    await evaluationRuntime.flushAndShutdown();
  }
}
