/**
 * Recovery operation root — create-only CAS keyed by prior epoch + contract version.
 */

import { createHash } from "node:crypto";
import { CursorProvenanceError } from "./errors.js";
import type { ProvenanceLifecycleStore } from "./lifecycle-store.js";
import { recoveryOperationRootRemotePath } from "./paths.js";

export const RECOVERY_OPERATION_ROOT_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-recovery-operation-root.v1" as const;

export const DEFAULT_RECOVERY_CONTRACT_VERSION = "1" as const;

export interface RecoveryOperationRootRecord {
  kind: typeof RECOVERY_OPERATION_ROOT_SCHEMA_KIND;
  version: "1";
  recoveryOperationId: string;
  newEpochId: string;
  plannedStage: string;
  activationScheduleIdentity: string;
  creatorSessionId: string;
  contractVersion: string;
  priorEpochId: string;
  rootDigest: string;
}

export interface CreateRecoveryRootInput {
  priorEpochId: string;
  contractVersion?: string;
  recoveryOperationId: string;
  newEpochId: string;
  plannedStage: string;
  activationScheduleIdentity: string;
  creatorSessionId: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function recoveryRootSubjectKey(
  priorEpochId: string,
  contractVersion: string,
): string {
  return `${priorEpochId}/${contractVersion}`;
}

export function buildRecoveryOperationRootRecord(
  input: CreateRecoveryRootInput & { contractVersion: string },
): RecoveryOperationRootRecord {
  if (!input.priorEpochId.trim()) {
    throw new Error("priorEpochId is required");
  }
  if (!input.newEpochId.trim()) {
    throw new Error("newEpochId is required");
  }
  if (!UUID_RE.test(input.recoveryOperationId)) {
    throw new Error("recoveryOperationId must be a UUID");
  }
  if (!input.plannedStage.trim()) {
    throw new Error("plannedStage is required");
  }
  if (!input.activationScheduleIdentity.trim()) {
    throw new Error("activationScheduleIdentity is required");
  }

  const partial: Omit<RecoveryOperationRootRecord, "rootDigest"> = {
    kind: RECOVERY_OPERATION_ROOT_SCHEMA_KIND,
    version: "1",
    recoveryOperationId: input.recoveryOperationId,
    newEpochId: input.newEpochId,
    plannedStage: input.plannedStage,
    activationScheduleIdentity: input.activationScheduleIdentity,
    creatorSessionId: input.creatorSessionId,
    contractVersion: input.contractVersion,
    priorEpochId: input.priorEpochId,
  };
  const rootDigest = createHash("sha256")
    .update(stableStringify(partial), "utf8")
    .digest("hex");
  return { ...partial, rootDigest };
}

export function recoveryOperationRootDigest(
  record: RecoveryOperationRootRecord,
): string {
  const recomputed = buildRecoveryOperationRootRecord(record);
  return recomputed.rootDigest;
}

export function parseRecoveryOperationRootRecord(
  bytes: string | object,
): RecoveryOperationRootRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as RecoveryOperationRootRecord;
  if (
    parsed.kind !== RECOVERY_OPERATION_ROOT_SCHEMA_KIND ||
    parsed.version !== "1"
  ) {
    throw new Error("invalid recovery operation root record");
  }
  const recomputed = buildRecoveryOperationRootRecord(parsed);
  if (recomputed.rootDigest !== parsed.rootDigest) {
    throw new Error("recovery operation root digest mismatch");
  }
  return parsed;
}

function recordsCompatibleForAdoption(
  existing: RecoveryOperationRootRecord,
  intended: CreateRecoveryRootInput & { contractVersion: string },
): boolean {
  return (
    existing.priorEpochId === intended.priorEpochId &&
    existing.contractVersion === intended.contractVersion &&
    existing.recoveryOperationId === intended.recoveryOperationId &&
    existing.newEpochId === intended.newEpochId &&
    existing.plannedStage === intended.plannedStage &&
    existing.activationScheduleIdentity === intended.activationScheduleIdentity
  );
}

export interface RecoveryRootWriteResult {
  idempotent: boolean;
  adopted: boolean;
  commitSha: string | null;
  path: string;
  record: RecoveryOperationRootRecord;
}

export async function createOrAdoptRecoveryRoot(
  store: ProvenanceLifecycleStore,
  input: CreateRecoveryRootInput,
): Promise<RecoveryRootWriteResult> {
  const contractVersion =
    input.contractVersion ?? DEFAULT_RECOVERY_CONTRACT_VERSION;
  const record = buildRecoveryOperationRootRecord({ ...input, contractVersion });
  const path = recoveryOperationRootRemotePath(
    input.priorEpochId,
    contractVersion,
  );
  const body = `${JSON.stringify(record, null, 2)}\n`;

  try {
    const result = await store.persistImmutableRecord({
      path,
      body,
      canonicalDigest: record.rootDigest,
      commitMessage: `p-dev: recovery root ${input.priorEpochId}/${contractVersion}`,
    });
    return {
      idempotent: result.idempotent,
      adopted: false,
      commitSha: result.commitSha,
      path,
      record,
    };
  } catch (error) {
    if (
      !(error instanceof CursorProvenanceError) ||
      error.code !== "cursor_provenance_event_divergence"
    ) {
      throw error;
    }
    const existingBody = await store.loadRecord(path);
    if (!existingBody) {
      throw error;
    }
    const existing = parseRecoveryOperationRootRecord(existingBody);
    if (
      !recordsCompatibleForAdoption(existing, { ...input, contractVersion })
    ) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "Recovery root exists with divergent recoveryOperationId or newEpochId.",
      );
    }
    return {
      idempotent: true,
      adopted: true,
      commitSha: store.commitShaForPath?.(path) ?? null,
      path,
      record: existing,
    };
  }
}
