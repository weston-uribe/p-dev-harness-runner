import { parseArgs } from "node:util";
import { loadHarnessConfig } from "../config/load-config.js";
import { PublicSafeLogger } from "../public-execution/logger.js";
import { isPublicRunnerMode } from "../public-execution/mode.js";
import { readPrivateIssueKey } from "../public-execution/private-runtime-context.js";
import {
  ensureHarnessRunJsonOut,
  finalizeFailedHarnessRun,
} from "../runner/failure-finalization.js";
import { resolveRunGeneration } from "../runner/run-generation.js";
import {
  completeJobRequest,
  failJobRequest,
  JobRequestError,
} from "./job-request/claim.js";
import {
  createGithubJobRequestStoreFromEnv,
  JobRequestRuntimeError,
} from "./job-request/runtime-store.js";
import { readJsonOutManifest } from "../artifacts/write-json-out-manifest.js";

function parseExitCode(value: string | undefined): number {
  if (!value) {
    return 1;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

async function terminalizeJobRequest(input: {
  requestId: string | null;
  exitCode: number;
  jsonOutPath: string;
}): Promise<{ terminalized: boolean; state?: string; reason?: string }> {
  const requestId = input.requestId?.trim();
  if (!requestId) {
    return { terminalized: false, reason: "request_id_missing" };
  }

  try {
    const store = await createGithubJobRequestStoreFromEnv();
    const manifest = await readJsonOutManifest(input.jsonOutPath);
    const completionState =
      manifest?.errorClassification ??
      (input.exitCode === 0 ? "verified_complete" : "run_failed");

    if (input.exitCode === 0) {
      const completed = await completeJobRequest(store, {
        requestId,
        completionState,
      });
      return { terminalized: true, state: completed.state };
    }

    const failed = await failJobRequest(store, {
      requestId,
      completionState,
    });
    return { terminalized: true, state: failed.state };
  } catch (error) {
    if (
      error instanceof JobRequestError &&
      error.code === "already_completed"
    ) {
      return { terminalized: true, reason: "already_terminal" };
    }
    if (
      error instanceof JobRequestRuntimeError ||
      error instanceof JobRequestError
    ) {
      return {
        terminalized: false,
        reason: error.code,
      };
    }
    return {
      terminalized: false,
      reason: error instanceof Error ? error.message : "job_request_terminalize_failed",
    };
  }
}

const { values } = parseArgs({
  options: {
    issue: { type: "string" },
    "json-out": { type: "string" },
    "exit-code": { type: "string" },
    config: { type: "string", default: "harness.config.json" },
    "delivery-id": { type: "string" },
    "request-id": { type: "string" },
    generation: { type: "string" },
  },
  allowPositionals: false,
});

const issueKey = values.issue?.trim() || readPrivateIssueKey();
if (!issueKey || !values["json-out"]) {
  console.error(
    "Usage: finalize-harness-run --issue <KEY> --json-out <path> [--exit-code N]",
  );
  process.exit(1);
}
const jsonOutPath = values["json-out"];
const exitCode = parseExitCode(values["exit-code"]);
const configPath = values.config ?? "harness.config.json";
const deliveryId = values["delivery-id"] ?? process.env.LINEAR_DELIVERY_ID ?? null;
const requestId =
  values["request-id"]?.trim() ||
  process.env.REQUEST_ID?.trim() ||
  process.env.P_DEV_REQUEST_ID?.trim() ||
  null;
const generation =
  values.generation !== undefined ? Number(values.generation) : resolveRunGeneration();

await loadHarnessConfig({ configPath });

await ensureHarnessRunJsonOut({
  issueKey,
  jsonOutPath,
  configPath,
  deliveryId,
  requestId,
  generation,
});

if (exitCode === 0) {
  const terminal = await terminalizeJobRequest({
    requestId,
    exitCode,
    jsonOutPath,
  });
  if (isPublicRunnerMode()) {
    new PublicSafeLogger().log({
      phase: "finalize",
      outcome: "success",
      publicEventType: "harness_finalize_skip",
      requestId: requestId ?? undefined,
      success: terminal.terminalized,
    });
  } else {
    console.log(
      JSON.stringify({
        skipped: true,
        jobRequestTerminal: terminal.state ?? terminal.reason ?? null,
      }),
    );
  }
  process.exit(0);
}

const result = await finalizeFailedHarnessRun({
  issueKey,
  jsonOutPath,
  exitCode,
  configPath,
  deliveryId,
  requestId,
  generation,
});

const terminal = await terminalizeJobRequest({
  requestId,
  exitCode,
  jsonOutPath,
});

if (isPublicRunnerMode()) {
  new PublicSafeLogger().log({
    phase: "finalize",
    outcome:
      result.manifest.finalOutcome === "failed" || result.blocked
        ? "failure"
        : "success",
    errorCode: result.manifest.errorClassification ?? result.reason ?? undefined,
    publicEventType: "harness_finalize",
    requestId: requestId ?? undefined,
    success: terminal.terminalized,
  });
} else {
  console.log(
    JSON.stringify(
      {
        skipped: result.skipped,
        blocked: result.blocked,
        reason: result.reason ?? null,
        commentAction: result.commentAction ?? null,
        finalOutcome: result.manifest.finalOutcome,
        errorClassification: result.manifest.errorClassification,
        jobRequestTerminal: terminal.state ?? terminal.reason ?? null,
      },
      null,
      2,
    ),
  );
}

process.exit(0);
