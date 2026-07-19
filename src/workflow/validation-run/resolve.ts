/**
 * Fail-closed resolver: apply a validation-run override only when the issue
 * is allowlisted, the run is active, schema matches, and readiness allows.
 * Never falls back to globally enabling review phases.
 */

import { WORKFLOW_SCHEMA_VERSION } from "../definition/product-development.v2.js";
import {
  listValidationRunSnapshots,
  parseValidationRunSnapshot,
  refreshExpiredValidationRuns,
} from "./store.js";
import type {
  ResolvedIssueConfiguration,
  ValidationRunSnapshot,
} from "./types.js";

function normalizeIssueId(id: string): string {
  return id.trim().toUpperCase();
}

export function issueAllowlisted(
  snapshot: ValidationRunSnapshot,
  issueKey: string,
): boolean {
  const target = normalizeIssueId(issueKey);
  return snapshot.allowedIssueIds.some(
    (id) => normalizeIssueId(id) === target,
  );
}

export type SnapshotRunnableFailureReason =
  | "expired"
  | "completed"
  | "malformed"
  | "issue_not_allowlisted"
  | "schema_mismatch"
  | "wrong_team";

export function isSnapshotRunnable(
  snapshot: ValidationRunSnapshot,
  input: {
    issueKey: string;
    workflowSchemaVersion?: string;
    linearTeamId?: string | null;
    now?: Date;
  },
): { ok: true } | { ok: false; reason: SnapshotRunnableFailureReason } {
  if (snapshot.state === "expired") {
    return { ok: false, reason: "expired" };
  }
  if (snapshot.state === "completed") {
    return { ok: false, reason: "completed" };
  }
  if (snapshot.state !== "active") {
    return { ok: false, reason: "malformed" };
  }
  const now = input.now ?? new Date();
  if (snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (!issueAllowlisted(snapshot, input.issueKey)) {
    return { ok: false, reason: "issue_not_allowlisted" };
  }
  const schema =
    input.workflowSchemaVersion?.trim() || WORKFLOW_SCHEMA_VERSION;
  if (snapshot.workflowSchemaVersion !== schema) {
    return { ok: false, reason: "schema_mismatch" };
  }
  if (
    input.linearTeamId &&
    snapshot.linearTeamId &&
    input.linearTeamId !== snapshot.linearTeamId
  ) {
    return { ok: false, reason: "wrong_team" };
  }
  return { ok: true };
}

/**
 * Find the active override for an issue. Prefer the most recently created
 * matching snapshot. Concurrent runs with disjoint allowlists do not cross-apply.
 */
export async function resolveIssueConfiguration(input: {
  issueKey?: string | null;
  cwd?: string;
  workflowSchemaVersion?: string;
  linearTeamId?: string | null;
  /** When set, only this validation run may apply (claim freeze continuity). */
  requiredValidationRunId?: string | null;
  now?: Date;
  /** Cloud-synced snapshots from harness config.validationRuns (not optionalPhases). */
  inlineSnapshots?: readonly unknown[] | null;
}): Promise<ResolvedIssueConfiguration> {
  const issueKey = input.issueKey?.trim();
  if (!issueKey) {
    return {
      applied: false,
      configurationSource: "default",
      reason: "no_issue_key",
    };
  }

  await refreshExpiredValidationRuns(input.cwd, () => input.now ?? new Date());
  const fromDisk = await listValidationRunSnapshots(input.cwd);
  const fromConfig: ValidationRunSnapshot[] = [];
  for (const raw of input.inlineSnapshots ?? []) {
    const parsed = parseValidationRunSnapshot(raw);
    if (parsed) fromConfig.push(parsed);
  }
  // Prefer disk snapshots when ids collide (operator local wins).
  const byId = new Map<string, ValidationRunSnapshot>();
  for (const snap of fromConfig) byId.set(snap.validationRunId, snap);
  for (const snap of fromDisk) byId.set(snap.validationRunId, snap);
  const snapshots = [...byId.values()];

  if (input.requiredValidationRunId) {
    const pinned = snapshots.find(
      (s) => s.validationRunId === input.requiredValidationRunId,
    );
    if (!pinned) {
      return {
        applied: false,
        configurationSource: "default",
        reason: "malformed",
      };
    }
    // Claimed executions continue under freeze even if later completed/expired
    // for *routing of already-frozen claims* — callers use freeze directly.
    // For *new* reviewer starts, requiredValidationRunId with inactive state fails.
    const runnable = isSnapshotRunnable(pinned, {
      issueKey,
      workflowSchemaVersion: input.workflowSchemaVersion,
      linearTeamId: input.linearTeamId,
      now: input.now,
    });
    if (!runnable.ok) {
      return {
        applied: false,
        configurationSource: "default",
        reason: runnable.reason,
      };
    }
    return {
      applied: true,
      configurationSource: "validation_run_override",
      snapshot: pinned,
      validationRunId: pinned.validationRunId,
    };
  }

  const candidates = snapshots
    .filter((s) => s.state === "active")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  for (const snap of candidates) {
    const runnable = isSnapshotRunnable(snap, {
      issueKey,
      workflowSchemaVersion: input.workflowSchemaVersion,
      linearTeamId: input.linearTeamId,
      now: input.now,
    });
    if (runnable.ok) {
      return {
        applied: true,
        configurationSource: "validation_run_override",
        snapshot: snap,
        validationRunId: snap.validationRunId,
      };
    }
  }

  return {
    applied: false,
    configurationSource: "default",
    reason: "no_active_override",
  };
}

/**
 * Whether a claimed freeze may continue after override expiry/removal.
 * New reviewer starts must not use this path when override is inactive.
 */
export function freezeMatchesValidationRun(input: {
  freezeValidationRunId: string | null | undefined;
  snapshotValidationRunId: string;
}): boolean {
  return (
    typeof input.freezeValidationRunId === "string" &&
    input.freezeValidationRunId.length > 0 &&
    input.freezeValidationRunId === input.snapshotValidationRunId
  );
}

export function observabilityPropsForConfiguration(
  resolved: ResolvedIssueConfiguration,
): Record<string, string | boolean> {
  if (resolved.applied) {
    return {
      configuration_source: resolved.configurationSource,
      validation_run_id: resolved.validationRunId,
    };
  }
  return {
    configuration_source: resolved.configurationSource,
    validation_run_id: "",
  };
}
