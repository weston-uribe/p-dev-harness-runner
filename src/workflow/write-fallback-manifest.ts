import { parseArgs } from "node:util";
import {
  buildFallbackRunManifest,
  writeJsonOutManifest,
} from "../artifacts/write-json-out-manifest.js";
import { resolveRunGeneration } from "../runner/run-generation.js";
import type { ErrorClassification } from "../types/run.js";

const { values } = parseArgs({
  options: {
    issue: { type: "string" },
    "json-out": { type: "string" },
    "error-classification": { type: "string" },
    message: { type: "string" },
    "delivery-id": { type: "string" },
    generation: { type: "string" },
  },
  allowPositionals: false,
});

if (!values.issue || !values["json-out"]) {
  console.error("Usage: write-fallback-manifest --issue <KEY> --json-out <path>");
  process.exit(1);
}

const manifest = buildFallbackRunManifest({
  issueKey: values.issue,
  errorClassification:
    (values["error-classification"] as ErrorClassification | undefined) ??
    "run_crash",
  message: values.message,
  deliveryId: values["delivery-id"] ?? process.env.LINEAR_DELIVERY_ID ?? null,
  runGeneration:
    values.generation !== undefined
      ? Number(values.generation)
      : resolveRunGeneration(),
});

await writeJsonOutManifest(values["json-out"], manifest);
