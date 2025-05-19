/**
 * Append-only canary stage / attempt transition chain.
 */

import { createHash } from "node:crypto";
import { CursorProvenanceError } from "./errors.js";
import type { ProvenanceLifecycleStore } from "./lifecycle-store.js";
import {
  recoveryAttemptRootRemotePath,
  recoveryAttemptTransitionRemotePath,
  recoveryStageRootRemotePath,
} from "./paths.js";

export const CANARY_STAGE_ROOT_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-canary-stage-root.v1" as const;

export const CANARY_ATTEMPT_ROOT_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-canary-attempt-root.v1" as const;

export const CANARY_ATTEMPT_TRANSITION_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-canary-attempt-transition.v1" as const;

export const CANARY_ATTEMPT_TRANSITION_V2_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-canary-attempt-transition.v2" as const;

export type CanaryAttemptTransitionKind =
  | "issue_create_intent"
  | "issue_created"
  | "trigger_intent"
  | "trigger_ack"
  | "observe_terminal_success"
  | "observe_terminal_failure"
  | "replacement_authorized"
  | "duplicate_incident";

export type CanaryAttemptTransitionKindV2 =
  | "issue_create_intent"
  | "issue_created"
  | "issue_validated"
  | "trigger_intent"
  | "trigger_acknowledged"
  | "workflow_bound"
  | "provider_operation_bound"
  | "terminal_success"
  | "terminal_failure"
  | "duplicate_incident"
  | "replacement_authorized";

export interface CanaryStageRootRecord {
  kind: typeof CANARY_STAGE_ROOT_SCHEMA_KIND;
  version: "1";
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  firstAttemptOrdinal: 1;
  contractVersion: string;
  stageRootDigest: string;
}

export interface CanaryAttemptRootRecord {
  kind: typeof CANARY_ATTEMPT_ROOT_SCHEMA_KIND;
  version: "1";
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  ordinal: number;
  operationId: string;
  contractVersion: string;
  attemptRootDigest: string;
}

export interface CanaryAttemptTransitionRecord {
  kind: typeof CANARY_ATTEMPT_TRANSITION_SCHEMA_KIND;
  version: "1";
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  ordinal: number;
  transitionId: string;
  transitionKind: CanaryAttemptTransitionKind;
  recordedAt: string;
  payloadDigest: string;
  transitionDigest: string;
}

export interface CanaryAttemptTransitionV2Record {
  kind: typeof CANARY_ATTEMPT_TRANSITION_V2_SCHEMA_KIND;
  version: "2";
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  ordinal: number;
  transitionId: string;
  transitionKind: CanaryAttemptTransitionKindV2;
  previousTransitionId: string | null;
  previousTransitionDigest: string | null;
  recordedAt: string;
  publicSafePayload: Record<string, unknown>;
  payloadDigest: string;
  transitionDigest: string;
  contractVersion: string;
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

const TERMINAL_TRANSITIONS = new Set<CanaryAttemptTransitionKind>([
  "observe_terminal_success",
  "observe_terminal_failure",
  "duplicate_incident",
]);

export function buildCanaryStageRootRecord(input: {
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  contractVersion?: string;
}): CanaryStageRootRecord {
  const partial: Omit<CanaryStageRootRecord, "stageRootDigest"> = {
    kind: CANARY_STAGE_ROOT_SCHEMA_KIND,
    version: "1",
    recoveryOperationId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
    firstAttemptOrdinal: 1,
    contractVersion: input.contractVersion ?? "1",
  };
  const stageRootDigest = createHash("sha256")
    .update(stableStringify(partial), "utf8")
    .digest("hex");
  return { ...partial, stageRootDigest };
}

export function buildCanaryAttemptRootRecord(input: {
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  ordinal: number;
  operationId: string;
  contractVersion?: string;
}): CanaryAttemptRootRecord {
  if (input.ordinal < 1) {
    throw new Error("attempt ordinal must be >= 1");
  }
  const partial: Omit<CanaryAttemptRootRecord, "attemptRootDigest"> = {
    kind: CANARY_ATTEMPT_ROOT_SCHEMA_KIND,
    version: "1",
    recoveryOperationId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
    ordinal: input.ordinal,
    operationId: input.operationId,
    contractVersion: input.contractVersion ?? "1",
  };
  const attemptRootDigest = createHash("sha256")
    .update(stableStringify(partial), "utf8")
    .digest("hex");
  return { ...partial, attemptRootDigest };
}

export function buildCanaryAttemptTransitionRecord(input: {
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  ordinal: number;
  transitionId: string;
  transitionKind: CanaryAttemptTransitionKind;
  recordedAt: string;
  payloadDigest?: string;
}): CanaryAttemptTransitionRecord {
  const payloadDigest =
    input.payloadDigest ??
    createHash("sha256")
      .update(
        `${input.transitionKind}|${input.recordedAt}|${input.transitionId}`,
        "utf8",
      )
      .digest("hex");
  const partial: Omit<CanaryAttemptTransitionRecord, "transitionDigest"> = {
    kind: CANARY_ATTEMPT_TRANSITION_SCHEMA_KIND,
    version: "1",
    recoveryOperationId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
    ordinal: input.ordinal,
    transitionId: input.transitionId,
    transitionKind: input.transitionKind,
    recordedAt: input.recordedAt,
    payloadDigest,
  };
  const transitionDigest = createHash("sha256")
    .update(stableStringify(partial), "utf8")
    .digest("hex");
  return { ...partial, transitionDigest };
}

export function buildCanaryAttemptTransitionV2Record(input: {
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  ordinal: number;
  transitionId: string;
  transitionKind: CanaryAttemptTransitionKindV2;
  previousTransitionId: string | null;
  previousTransitionDigest: string | null;
  recordedAt: string;
  publicSafePayload: Record<string, unknown>;
  contractVersion?: string;
}): CanaryAttemptTransitionV2Record {
  const payloadDigest = createHash("sha256")
    .update(stableStringify(input.publicSafePayload), "utf8")
    .digest("hex");
  const partial: Omit<CanaryAttemptTransitionV2Record, "transitionDigest"> = {
    kind: CANARY_ATTEMPT_TRANSITION_V2_SCHEMA_KIND,
    version: "2",
    recoveryOperationId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
    ordinal: input.ordinal,
    transitionId: input.transitionId,
    transitionKind: input.transitionKind,
    previousTransitionId: input.previousTransitionId,
    previousTransitionDigest: input.previousTransitionDigest,
    recordedAt: input.recordedAt,
    publicSafePayload: input.publicSafePayload,
    payloadDigest,
    contractVersion: input.contractVersion ?? "2",
  };
  const transitionDigest = createHash("sha256")
    .update(stableStringify(partial), "utf8")
    .digest("hex");
  return { ...partial, transitionDigest };
}

export function parseCanaryStageRootRecord(
  bytes: string | object,
): CanaryStageRootRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as CanaryStageRootRecord;
  if (parsed.kind !== CANARY_STAGE_ROOT_SCHEMA_KIND || parsed.version !== "1") {
    throw new Error("invalid canary stage root record");
  }
  const recomputed = buildCanaryStageRootRecord(parsed);
  if (recomputed.stageRootDigest !== parsed.stageRootDigest) {
    throw new Error("canary stage root digest mismatch");
  }
  return parsed;
}

export function parseCanaryAttemptRootRecord(
  bytes: string | object,
): CanaryAttemptRootRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as CanaryAttemptRootRecord;
  if (parsed.kind !== CANARY_ATTEMPT_ROOT_SCHEMA_KIND || parsed.version !== "1") {
    throw new Error("invalid canary attempt root record");
  }
  const recomputed = buildCanaryAttemptRootRecord(parsed);
  if (recomputed.attemptRootDigest !== parsed.attemptRootDigest) {
    throw new Error("canary attempt root digest mismatch");
  }
  return parsed;
}

export function parseCanaryAttemptTransitionRecord(
  bytes: string | object,
): CanaryAttemptTransitionRecord {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as CanaryAttemptTransitionRecord;
  if (
    parsed.kind !== CANARY_ATTEMPT_TRANSITION_SCHEMA_KIND ||
    parsed.version !== "1"
  ) {
    throw new Error("invalid canary attempt transition record");
  }
  const recomputed = buildCanaryAttemptTransitionRecord(parsed);
  if (recomputed.transitionDigest !== parsed.transitionDigest) {
    throw new Error("canary attempt transition digest mismatch");
  }
  return parsed;
}

export function parseCanaryAttemptTransitionV2Record(
  bytes: string | object,
): CanaryAttemptTransitionV2Record {
  const parsed = (
    typeof bytes === "string" ? JSON.parse(bytes) : bytes
  ) as CanaryAttemptTransitionV2Record;
  if (
    parsed.kind !== CANARY_ATTEMPT_TRANSITION_V2_SCHEMA_KIND ||
    parsed.version !== "2"
  ) {
    throw new Error("invalid canary attempt transition v2 record");
  }
  const recomputed = buildCanaryAttemptTransitionV2Record(parsed);
  if (recomputed.transitionDigest !== parsed.transitionDigest) {
    throw new Error("canary attempt transition v2 digest mismatch");
  }
  return parsed;
}

export interface CanaryStageChainState {
  stageRoot: CanaryStageRootRecord | null;
  attemptRoots: CanaryAttemptRootRecord[];
  transitions: CanaryAttemptTransitionRecord[];
  activeOrdinal: number | null;
  finalOrdinal: number | null;
}

export function deriveCanaryStageChainState(input: {
  stageRoot: CanaryStageRootRecord | null;
  attemptRoots: CanaryAttemptRootRecord[];
  transitions: CanaryAttemptTransitionRecord[];
}): CanaryStageChainState {
  const attemptRoots = [...input.attemptRoots].sort(
    (a, b) => a.ordinal - b.ordinal,
  );
  const transitions = [...input.transitions].sort((a, b) => {
    const ord = a.ordinal - b.ordinal;
    if (ord !== 0) return ord;
    return a.recordedAt.localeCompare(b.recordedAt);
  });

  const ordinals = new Set(attemptRoots.map((row) => row.ordinal));
  if (ordinals.has(1) && attemptRoots.filter((r) => r.ordinal === 1).length > 1) {
    throw new CursorProvenanceError(
      "cursor_provenance_event_divergence",
      "Multiple ordinal-1 attempt roots are not allowed.",
    );
  }

  let activeOrdinal: number | null = null;
  let finalOrdinal: number | null = null;

  for (const ordinal of [...ordinals].sort((a, b) => a - b)) {
    const attemptTransitions = transitions.filter((t) => t.ordinal === ordinal);
    const terminals = attemptTransitions.filter((t) =>
      TERMINAL_TRANSITIONS.has(t.transitionKind),
    );
    const hasReplacementAfterFailure =
      terminals.some((t) => t.transitionKind === "observe_terminal_failure") &&
      attemptTransitions.some(
        (t) => t.transitionKind === "replacement_authorized",
      );
    if (terminals.length > 1) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        `Conflicting terminal transitions for ordinal ${ordinal}.`,
      );
    }
    if (terminals.length === 1 && !hasReplacementAfterFailure) {
      finalOrdinal = ordinal;
      activeOrdinal = null;
      continue;
    }
    activeOrdinal = ordinal;
  }

  if (ordinals.has(2) && !ordinals.has(1)) {
    throw new CursorProvenanceError(
      "cursor_provenance_event_divergence",
      "Ordinal 2 requires ordinal 1 attempt root.",
    );
  }

  if (ordinals.has(2)) {
    const auth = transitions.find(
      (t) =>
        t.ordinal === 1 && t.transitionKind === "replacement_authorized",
    );
    const failure = transitions.find(
      (t) =>
        t.ordinal === 1 && t.transitionKind === "observe_terminal_failure",
    );
    if (!auth || !failure) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "Ordinal 2 requires replacement_authorized after ordinal-1 terminal failure.",
      );
    }
    if (Date.parse(auth.recordedAt) < Date.parse(failure.recordedAt)) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "replacement_authorized must follow terminal failure.",
      );
    }
  }

  return {
    stageRoot: input.stageRoot,
    attemptRoots,
    transitions,
    activeOrdinal,
    finalOrdinal,
  };
}

export interface ImmutableWriteResult<T> {
  idempotent: boolean;
  commitSha: string | null;
  path: string;
  record: T;
}

export async function createOrAdoptStageRoot(
  store: ProvenanceLifecycleStore,
  input: {
    recoveryOperationId: string;
    epochId: string;
    stage: string;
    contractVersion?: string;
  },
): Promise<ImmutableWriteResult<CanaryStageRootRecord>> {
  const record = buildCanaryStageRootRecord(input);
  const path = recoveryStageRootRemotePath({
    recoveryOpId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
  });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  try {
    const result = await store.persistImmutableRecord({
      path,
      body,
      canonicalDigest: record.stageRootDigest,
      commitMessage: `p-dev: canary stage root ${input.stage}`,
    });
    return { idempotent: result.idempotent, commitSha: result.commitSha, path, record };
  } catch (error) {
    if (
      error instanceof CursorProvenanceError &&
      error.code === "cursor_provenance_event_divergence"
    ) {
      const existingBody = await store.loadRecord(path);
      if (!existingBody) throw error;
      const existing = parseCanaryStageRootRecord(existingBody);
      if (existing.stageRootDigest !== record.stageRootDigest) {
        throw error;
      }
      return {
        idempotent: true,
        commitSha: store.commitShaForPath?.(path) ?? null,
        path,
        record: existing,
      };
    }
    throw error;
  }
}

export async function createAttemptRoot(
  store: ProvenanceLifecycleStore,
  input: {
    recoveryOperationId: string;
    epochId: string;
    stage: string;
    ordinal: number;
    operationId: string;
    contractVersion?: string;
    existingAttemptRoots?: CanaryAttemptRootRecord[];
    existingTransitions?: CanaryAttemptTransitionRecord[];
  },
): Promise<ImmutableWriteResult<CanaryAttemptRootRecord>> {
  if (input.existingAttemptRoots && input.existingTransitions) {
    deriveCanaryStageChainState({
      stageRoot: null,
      attemptRoots: [
        ...input.existingAttemptRoots,
        buildCanaryAttemptRootRecord(input),
      ],
      transitions: input.existingTransitions,
    });
  }

  const record = buildCanaryAttemptRootRecord(input);
  const path = recoveryAttemptRootRemotePath({
    recoveryOpId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
    ordinal: input.ordinal,
  });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const result = await store.persistImmutableRecord({
    path,
    body,
    canonicalDigest: record.attemptRootDigest,
    commitMessage: `p-dev: canary attempt ${input.ordinal}`,
  });
  return { idempotent: result.idempotent, commitSha: result.commitSha, path, record };
}

export async function appendTransition(
  store: ProvenanceLifecycleStore,
  input: {
    recoveryOperationId: string;
    epochId: string;
    stage: string;
    ordinal: number;
    transitionId: string;
    transitionKind: CanaryAttemptTransitionKind;
    recordedAt: string;
    payloadDigest?: string;
    existingAttemptRoots?: CanaryAttemptRootRecord[];
    existingTransitions?: CanaryAttemptTransitionRecord[];
  },
): Promise<ImmutableWriteResult<CanaryAttemptTransitionRecord>> {
  const record = buildCanaryAttemptTransitionRecord(input);
  if (input.existingAttemptRoots && input.existingTransitions) {
    deriveCanaryStageChainState({
      stageRoot: null,
      attemptRoots: input.existingAttemptRoots,
      transitions: [...input.existingTransitions, record],
    });
  }

  const path = recoveryAttemptTransitionRemotePath({
    recoveryOpId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
    ordinal: input.ordinal,
    transitionId: input.transitionId,
  });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const result = await store.persistImmutableRecord({
    path,
    body,
    canonicalDigest: record.transitionDigest,
    commitMessage: `p-dev: canary transition ${input.transitionKind}`,
  });
  return { idempotent: result.idempotent, commitSha: result.commitSha, path, record };
}
