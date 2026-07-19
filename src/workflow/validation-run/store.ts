/**
 * Durable store for validation-run snapshots under `.harness/validation-runs/`.
 * Not merged into shared workflow.optionalPhases / cloud default config.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveLocalFilePaths } from "../../setup/setup-state.js";
import { getParamValue } from "../../models/resolution.js";
import type { RoleModelSelection } from "../../config/role-models.js";
import {
  VALIDATION_RUN_SNAPSHOT_KIND,
  type ValidationRunCleanupReport,
  type ValidationRunOptionalPhases,
  type ValidationRunPromptConfig,
  type ValidationRunReadinessSnapshot,
  type ValidationRunSnapshot,
  type ValidationRunState,
} from "./types.js";

function isFast(selection?: RoleModelSelection): boolean | null {
  if (!selection) return null;
  const v = getParamValue(selection.params, "fast");
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

export function validationRunsDir(cwd?: string): string {
  const { harnessDir } = resolveLocalFilePaths(cwd);
  return path.join(harnessDir, "validation-runs");
}

function snapshotPath(validationRunId: string, cwd?: string): string {
  return path.join(validationRunsDir(cwd), `${validationRunId}.json`);
}

export function parseValidationRunSnapshot(
  raw: unknown,
): ValidationRunSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== VALIDATION_RUN_SNAPSHOT_KIND) return null;
  if (typeof o.validationRunId !== "string" || !o.validationRunId.trim()) {
    return null;
  }
  if (
    o.state !== "active" &&
    o.state !== "expired" &&
    o.state !== "completed"
  ) {
    return null;
  }
  if (typeof o.linearTeamId !== "string" || typeof o.linearProjectId !== "string") {
    return null;
  }
  if (!Array.isArray(o.allowedIssueIds) || o.allowedIssueIds.length === 0) {
    return null;
  }
  if (!o.allowedIssueIds.every((id) => typeof id === "string" && id.trim())) {
    return null;
  }
  const phases = o.requestedOptionalPhases as ValidationRunOptionalPhases | undefined;
  if (
    !phases ||
    typeof phases.planReview !== "boolean" ||
    typeof phases.codeReview !== "boolean"
  ) {
    return null;
  }
  if (typeof o.workflowSchemaVersion !== "string" || !o.workflowSchemaVersion) {
    return null;
  }
  if (typeof o.createdAt !== "string") return null;
  return o as unknown as ValidationRunSnapshot;
}

export async function writeValidationRunSnapshot(
  snapshot: ValidationRunSnapshot,
  cwd?: string,
): Promise<string> {
  const dir = validationRunsDir(cwd);
  await mkdir(dir, { recursive: true });
  const dest = snapshotPath(snapshot.validationRunId, cwd);
  const tmp = `${dest}.tmp-${process.pid}-${randomUUID()}`;
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, dest);
  return dest;
}

export async function readValidationRunSnapshot(
  validationRunId: string,
  cwd?: string,
): Promise<ValidationRunSnapshot | null> {
  try {
    const raw = JSON.parse(
      await readFile(snapshotPath(validationRunId, cwd), "utf8"),
    ) as unknown;
    return parseValidationRunSnapshot(raw);
  } catch {
    return null;
  }
}

export async function listValidationRunSnapshots(
  cwd?: string,
): Promise<ValidationRunSnapshot[]> {
  const dir = validationRunsDir(cwd);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ValidationRunSnapshot[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
    try {
      const raw = JSON.parse(
        await readFile(path.join(dir, name), "utf8"),
      ) as unknown;
      const parsed = parseValidationRunSnapshot(raw);
      if (parsed) out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export interface CreateValidationRunInput {
  validationRunId?: string;
  linearTeamId: string;
  linearProjectId: string;
  allowedIssueIds: string[];
  requestedOptionalPhases: ValidationRunOptionalPhases;
  effectiveReadiness?: ValidationRunReadinessSnapshot;
  modelSelections?: ValidationRunSnapshot["modelSelections"];
  cycleLimits?: Partial<ValidationRunSnapshot["cycleLimits"]>;
  prompt?: ValidationRunPromptConfig;
  workflowSchemaVersion: string;
  expiresAt?: string | null;
  cwd?: string;
  now?: () => Date;
}

export async function createValidationRunSnapshot(
  input: CreateValidationRunInput,
): Promise<ValidationRunSnapshot> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const modelSelections = input.modelSelections ?? {};
  const snapshot: ValidationRunSnapshot = {
    kind: VALIDATION_RUN_SNAPSHOT_KIND,
    validationRunId: input.validationRunId ?? randomUUID(),
    state: "active",
    linearTeamId: input.linearTeamId,
    linearProjectId: input.linearProjectId,
    allowedIssueIds: [
      ...new Set(input.allowedIssueIds.map((id) => id.trim()).filter(Boolean)),
    ],
    requestedOptionalPhases: { ...input.requestedOptionalPhases },
    effectiveReadiness: input.effectiveReadiness ?? {
      planReviewEffectiveEnabled: false,
      codeReviewConfiguredReady: false,
      missingRequirementCodes: [],
      evaluatedAt: now,
    },
    modelSelections,
    fastParameters: {
      planReviewer: isFast(modelSelections.planReviewer),
      codeReviewer: isFast(modelSelections.codeReviewer),
      codeReviser: isFast(modelSelections.codeReviser),
    },
    cycleLimits: {
      planReview: input.cycleLimits?.planReview ?? 4,
      codeReview: input.cycleLimits?.codeReview ?? 4,
    },
    prompt: input.prompt ?? { provider: "local" },
    workflowSchemaVersion: input.workflowSchemaVersion,
    createdAt: now,
    expiresAt: input.expiresAt ?? null,
    completedAt: null,
  };
  if (snapshot.allowedIssueIds.length === 0) {
    throw new Error("Validation run requires at least one allowlisted issue id");
  }
  if (
    !snapshot.requestedOptionalPhases.planReview &&
    !snapshot.requestedOptionalPhases.codeReview
  ) {
    throw new Error(
      "Validation run must request planReview and/or codeReview",
    );
  }
  await writeValidationRunSnapshot(snapshot, input.cwd);
  return snapshot;
}

async function setState(
  validationRunId: string,
  state: ValidationRunState,
  cwd?: string,
  now?: () => Date,
): Promise<ValidationRunSnapshot | null> {
  const existing = await readValidationRunSnapshot(validationRunId, cwd);
  if (!existing) return null;
  const ts = (now ?? (() => new Date()))().toISOString();
  const next: ValidationRunSnapshot = {
    ...existing,
    state,
    completedAt:
      state === "completed" || state === "expired"
        ? existing.completedAt ?? ts
        : existing.completedAt,
  };
  await writeValidationRunSnapshot(next, cwd);
  return next;
}

export async function completeValidationRun(
  validationRunId: string,
  cwd?: string,
): Promise<ValidationRunSnapshot | null> {
  return setState(validationRunId, "completed", cwd);
}

export async function expireValidationRun(
  validationRunId: string,
  cwd?: string,
): Promise<ValidationRunSnapshot | null> {
  return setState(validationRunId, "expired", cwd);
}

/** Mark expired by wall-clock when expiresAt is in the past. */
export async function refreshExpiredValidationRuns(
  cwd?: string,
  now?: () => Date,
): Promise<string[]> {
  const ts = (now ?? (() => new Date()))();
  const expiredIds: string[] = [];
  for (const snap of await listValidationRunSnapshots(cwd)) {
    if (snap.state !== "active") continue;
    if (snap.expiresAt && Date.parse(snap.expiresAt) <= ts.getTime()) {
      await expireValidationRun(snap.validationRunId, cwd);
      expiredIds.push(snap.validationRunId);
    }
  }
  return expiredIds;
}

export async function buildValidationRunCleanupReport(
  cwd?: string,
): Promise<ValidationRunCleanupReport> {
  await refreshExpiredValidationRuns(cwd);
  const all = await listValidationRunSnapshots(cwd);
  const active = all.filter((s) => s.state === "active");
  const expired = all.filter((s) => s.state === "expired");
  const completed = all.filter((s) => s.state === "completed");
  return {
    activeCount: active.length,
    expiredCount: expired.length,
    completedCount: completed.length,
    activeValidationRunIds: active.map((s) => s.validationRunId),
    zeroActive: active.length === 0,
    reportedAt: new Date().toISOString(),
  };
}

export async function completeAllActiveValidationRuns(
  cwd?: string,
): Promise<ValidationRunCleanupReport> {
  for (const snap of await listValidationRunSnapshots(cwd)) {
    if (snap.state === "active") {
      await completeValidationRun(snap.validationRunId, cwd);
    }
  }
  return buildValidationRunCleanupReport(cwd);
}

export async function deleteValidationRunSnapshot(
  validationRunId: string,
  cwd?: string,
): Promise<void> {
  await rm(snapshotPath(validationRunId, cwd), { force: true });
}
