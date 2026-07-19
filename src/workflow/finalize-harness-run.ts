import { parseArgs } from "node:util";
import { loadHarnessConfig } from "../config/load-config.js";
import {
  ensureHarnessRunJsonOut,
  finalizeFailedHarnessRun,
} from "../runner/failure-finalization.js";
import { resolveRunGeneration } from "../runner/run-generation.js";

function parseExitCode(value: string | undefined): number {
  if (!value) {
    return 1;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

const { values } = parseArgs({
  options: {
    issue: { type: "string" },
    "json-out": { type: "string" },
    "exit-code": { type: "string" },
    config: { type: "string", default: "harness.config.json" },
    "delivery-id": { type: "string" },
    generation: { type: "string" },
  },
  allowPositionals: false,
});

if (!values.issue || !values["json-out"]) {
  console.error(
    "Usage: finalize-harness-run --issue <KEY> --json-out <path> [--exit-code N]",
  );
  process.exit(1);
}

const issueKey = values.issue;
const jsonOutPath = values["json-out"];
const exitCode = parseExitCode(values["exit-code"]);
const configPath = values.config ?? "harness.config.json";
const deliveryId = values["delivery-id"] ?? process.env.LINEAR_DELIVERY_ID ?? null;
const generation =
  values.generation !== undefined ? Number(values.generation) : resolveRunGeneration();

await loadHarnessConfig({ configPath });

await ensureHarnessRunJsonOut({
  issueKey,
  jsonOutPath,
  configPath,
  deliveryId,
  generation,
});

if (exitCode === 0) {
  console.log("Harness run succeeded; skipping failure finalization.");
  process.exit(0);
}

const result = await finalizeFailedHarnessRun({
  issueKey,
  jsonOutPath,
  exitCode,
  configPath,
  deliveryId,
  generation,
});

console.log(
  JSON.stringify(
    {
      skipped: result.skipped,
      blocked: result.blocked,
      reason: result.reason ?? null,
      commentAction: result.commentAction ?? null,
      finalOutcome: result.manifest.finalOutcome,
      errorClassification: result.manifest.errorClassification,
    },
    null,
    2,
  ),
);

process.exit(0);
