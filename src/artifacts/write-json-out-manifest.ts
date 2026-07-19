import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MILESTONE } from "../config/defaults.js";
import { isPublicRunnerMode } from "../public-execution/mode.js";
import { emptyMergeManifestFields } from "./manifest-fields.js";
import { redactSecrets } from "./redact.js";
import { createRunId } from "./run-id.js";
import type { ErrorClassification, RunManifest, RunPhase } from "../types/run.js";

const PUBLIC_MANIFEST_OMIT_KEYS = new Set([
  "issueKey",
  "targetRepo",
  "baseBranch",
  "branch",
  "prUrl",
  "previewUrl",
  "changedFiles",
  "validationSummary",
  "pmFeedbackCommentId",
  "cursorAgentId",
  "cursorRunId",
]);

function toPublicSafeManifest(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (PUBLIC_MANIFEST_OMIT_KEYS.has(key)) {
      continue;
    }
    out[key] = nested;
  }
  return out;
}

export interface FallbackManifestInput {
  issueKey: string;
  runId?: string;
  phase?: RunPhase;
  errorClassification?: ErrorClassification;
  message?: string;
  deliveryId?: string | null;
  runGeneration?: number | null;
  linearStatusBefore?: string | null;
  runOwnedStatuses?: string[] | null;
}

export function buildFallbackRunManifest(input: FallbackManifestInput): RunManifest {
  const startedAt = new Date().toISOString();
  const runId = input.runId ?? createRunId(input.issueKey, new Date(startedAt));

  return {
    runId,
    issueKey: input.issueKey,
    phase: input.phase ?? "none",
    phaseInferredFromStatus: input.linearStatusBefore ?? null,
    linearStatusBefore: input.linearStatusBefore ?? null,
    linearStatusAfter: input.linearStatusBefore ?? null,
    targetRepo: null,
    baseBranch: null,
    resolutionSource: null,
    dryRun: false,
    finalOutcome: "failed",
    errorClassification: input.errorClassification ?? null,
    startedAt,
    finishedAt: startedAt,
    milestone: MILESTONE,
    promptVersion: null,
    cursorAgentId: null,
    cursorRunId: null,
    branch: null,
    prUrl: null,
    previewUrl: null,
    validationSummary: input.message ?? null,
    changedFiles: null,
    checkSummary: null,
    previousImplementationRunId: null,
    previousHandoffRunId: null,
    pmFeedbackCommentId: null,
    ...emptyMergeManifestFields(),
    model: null,
    deliveryId: input.deliveryId ?? null,
    runGeneration: input.runGeneration ?? null,
    runOwnedStatuses: input.runOwnedStatuses ?? null,
  };
}

export async function writeJsonOutManifest(
  outputPath: string,
  manifest: unknown,
): Promise<void> {
  const redacted = redactSecrets(manifest);
  const payload = isPublicRunnerMode()
    ? toPublicSafeManifest(redacted)
    : redacted;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function readJsonOutManifest(outputPath: string): Promise<RunManifest | null> {
  try {
    const raw = await readFile(outputPath, "utf8");
    return JSON.parse(raw) as RunManifest;
  } catch {
    return null;
  }
}

export async function ensureJsonOutManifest(
  outputPath: string,
  fallback: FallbackManifestInput,
): Promise<RunManifest> {
  const existing = await readJsonOutManifest(outputPath);
  if (existing) {
    return existing;
  }
  const manifest = buildFallbackRunManifest(fallback);
  await writeJsonOutManifest(outputPath, manifest);
  return manifest;
}
