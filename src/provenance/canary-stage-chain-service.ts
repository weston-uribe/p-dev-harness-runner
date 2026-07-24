/**
 * Canary stage-chain service (v2 transitions).
 *
 * Goals:
 * - Always re-read authority from the lifecycle store.
 * - Validate predecessor links and fail closed on divergence.
 * - Use deterministic transition ids (no random UUIDs).
 */

import { createHash } from "node:crypto";
import { CursorProvenanceError } from "./errors.js";
import type { ProvenanceLifecycleStoreInterface } from "./lifecycle-store.js";
import {
  buildCanaryAttemptRootRecord,
  buildCanaryAttemptTransitionV2Record,
  buildCanaryStageRootRecord,
  parseCanaryAttemptRootRecord,
  parseCanaryAttemptTransitionV2Record,
  parseCanaryStageRootRecord,
  type CanaryAttemptRootRecord,
  type CanaryAttemptTransitionKindV2,
  type CanaryAttemptTransitionV2Record,
  type CanaryStageRootRecord,
} from "./canary-stage-chain.js";
import {
  recoveryAttemptRootRemotePath,
  recoveryAttemptTransitionRemotePath,
  recoveryStageRootRemotePath,
} from "./paths.js";

export interface CanaryStageChainV2State {
  stageRoot: CanaryStageRootRecord | null;
  attemptRoots: CanaryAttemptRootRecord[];
  transitions: CanaryAttemptTransitionV2Record[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

async function listAllLifecyclePaths(input: {
  store: ProvenanceLifecycleStoreInterface;
  listPaths?: () => Promise<string[]>;
}): Promise<string[]> {
  if (input.listPaths) {
    return input.listPaths();
  }
  if (typeof input.store.listPaths === "function") {
    return input.store.listPaths();
  }
  throw new CursorProvenanceError(
    "cursor_provenance_state_unavailable",
    "Lifecycle store does not support path enumeration.",
  );
}

function deriveTransitionId(input: {
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  ordinal: number;
  transitionKind: CanaryAttemptTransitionKindV2;
  payloadDigest: string;
  previousTransitionDigest: string | null;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        recoveryOperationId: input.recoveryOperationId,
        epochId: input.epochId,
        stage: input.stage,
        ordinal: input.ordinal,
        transitionKind: input.transitionKind,
        payloadDigest: input.payloadDigest,
        previousTransitionDigest: input.previousTransitionDigest,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
}

function chainForOrdinal(transitions: CanaryAttemptTransitionV2Record[], ordinal: number): {
  ordered: CanaryAttemptTransitionV2Record[];
  tail: CanaryAttemptTransitionV2Record | null;
} {
  const rows = transitions.filter((t) => t.ordinal === ordinal);
  if (rows.length === 0) return { ordered: [], tail: null };

  const byId = new Map(rows.map((t) => [t.transitionId, t] as const));
  const successors = new Map<string, CanaryAttemptTransitionV2Record>();
  for (const row of rows) {
    if (row.previousTransitionId) {
      if (successors.has(row.previousTransitionId)) {
        throw new CursorProvenanceError(
          "cursor_provenance_event_divergence",
          "Conflicting successor transitions detected.",
        );
      }
      successors.set(row.previousTransitionId, row);
    }
  }

  const heads = rows.filter((t) => t.previousTransitionId === null);
  if (heads.length !== 1) {
    throw new CursorProvenanceError(
      "cursor_provenance_event_divergence",
      "Transition chain must have exactly one head.",
    );
  }

  const ordered: CanaryAttemptTransitionV2Record[] = [];
  let cur: CanaryAttemptTransitionV2Record | null = heads[0] ?? null;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur.transitionId)) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "Transition chain contains a cycle.",
      );
    }
    seen.add(cur.transitionId);
    ordered.push(cur);
    cur = successors.get(cur.transitionId) ?? null;
  }

  // Ensure all transitions are reachable from the head.
  if (ordered.length !== rows.length) {
    throw new CursorProvenanceError(
      "cursor_provenance_event_divergence",
      "Transition chain is truncated or has multiple branches.",
    );
  }

  // Validate predecessor digest pins.
  for (let i = 0; i < ordered.length; i += 1) {
    const row = ordered[i]!;
    if (i === 0) {
      if (row.previousTransitionId !== null || row.previousTransitionDigest !== null) {
        throw new CursorProvenanceError(
          "cursor_provenance_event_divergence",
          "First transition must have null predecessor pins.",
        );
      }
      continue;
    }
    const prev = ordered[i - 1]!;
    if (row.previousTransitionId !== prev.transitionId) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "previousTransitionId does not match actual predecessor.",
      );
    }
    if (row.previousTransitionDigest !== prev.transitionDigest) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "previousTransitionDigest does not match actual predecessor.",
      );
    }
    if (Date.parse(row.recordedAt) < Date.parse(prev.recordedAt)) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "recordedAt must be monotonic within an attempt.",
      );
    }
    if (!byId.has(row.previousTransitionId)) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "previousTransitionId is missing from store.",
      );
    }
  }

  return { ordered, tail: ordered[ordered.length - 1] ?? null };
}

export async function readCanaryStageChainV2(input: {
  store: ProvenanceLifecycleStoreInterface;
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  listPaths?: () => Promise<string[]>;
}): Promise<CanaryStageChainV2State> {
  const stageRootPath = recoveryStageRootRemotePath({
    recoveryOpId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
  });
  const basePrefix = stageRootPath.replace(/\/stage-root\.json$/, "");
  const all = await listAllLifecyclePaths({ store: input.store, listPaths: input.listPaths });
  const relevant = all
    .filter((p) => p.startsWith(basePrefix))
    .filter((p) => p.endsWith(".json"))
    .sort();

  let stageRoot: CanaryStageRootRecord | null = null;
  const attemptRoots: CanaryAttemptRootRecord[] = [];
  const transitions: CanaryAttemptTransitionV2Record[] = [];

  for (const path of relevant) {
    const body = await input.store.loadRecord(path);
    if (!body) continue;
    if (path.endsWith("/stage-root.json")) {
      stageRoot = parseCanaryStageRootRecord(body);
      continue;
    }
    if (path.endsWith("/attempt-root.json")) {
      attemptRoots.push(parseCanaryAttemptRootRecord(body));
      continue;
    }
    if (path.includes("/transitions/")) {
      transitions.push(parseCanaryAttemptTransitionV2Record(body));
    }
  }

  // Validate per-ordinal predecessor chain.
  const ordinals = new Set(transitions.map((t) => t.ordinal));
  for (const ordinal of ordinals) {
    chainForOrdinal(transitions, ordinal);
  }

  // Ensure attempt roots exist for all transition ordinals.
  for (const ordinal of ordinals) {
    if (!attemptRoots.some((r) => r.ordinal === ordinal)) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        `Transitions exist without attempt root (ordinal ${ordinal}).`,
      );
    }
  }

  return {
    stageRoot,
    attemptRoots: attemptRoots.sort((a, b) => a.ordinal - b.ordinal),
    transitions: transitions.sort((a, b) => {
      const ord = a.ordinal - b.ordinal;
      if (ord !== 0) return ord;
      return a.recordedAt.localeCompare(b.recordedAt);
    }),
  };
}

export async function createOrAdoptCanaryStageRoot(input: {
  store: ProvenanceLifecycleStoreInterface;
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  contractVersion?: string;
}): Promise<{ path: string; record: CanaryStageRootRecord; idempotent: boolean }> {
  const record = buildCanaryStageRootRecord(input);
  const path = recoveryStageRootRemotePath({
    recoveryOpId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
  });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const result = await input.store.persistImmutableRecord({
    path,
    body,
    canonicalDigest: record.stageRootDigest,
    commitMessage: `p-dev: canary stage root ${input.stage}`,
  });
  return { path, record, idempotent: result.idempotent };
}

export async function createOrAdoptCanaryAttemptRoot(input: {
  store: ProvenanceLifecycleStoreInterface;
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  ordinal: number;
  operationId: string;
  contractVersion?: string;
}): Promise<{ path: string; record: CanaryAttemptRootRecord; idempotent: boolean }> {
  const record = buildCanaryAttemptRootRecord(input);
  const path = recoveryAttemptRootRemotePath({
    recoveryOpId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
    ordinal: input.ordinal,
  });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const result = await input.store.persistImmutableRecord({
    path,
    body,
    canonicalDigest: record.attemptRootDigest,
    commitMessage: `p-dev: canary attempt ${input.ordinal}`,
  });
  return { path, record, idempotent: result.idempotent };
}

/** Canonical linear order for a successful required-mode attempt (v2). */
const SUCCESS_CHAIN_ORDER: CanaryAttemptTransitionKindV2[] = [
  "issue_create_intent",
  "issue_created",
  "issue_validated",
  "trigger_intent",
  "trigger_acknowledged",
  "workflow_bound",
  "provider_operation_bound",
  "terminal_success",
];

function assertLegalNextTransition(input: {
  existingKinds: Set<CanaryAttemptTransitionKindV2>;
  next: CanaryAttemptTransitionKindV2;
}): void {
  const { existingKinds, next } = input;
  if (next === "duplicate_incident") {
    return;
  }
  if (next === "replacement_authorized") {
    if (!existingKinds.has("terminal_failure")) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "replacement_authorized requires prior terminal_failure.",
      );
    }
    return;
  }
  if (next === "terminal_failure") {
    if (!existingKinds.has("trigger_acknowledged")) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "terminal_failure requires prior trigger_acknowledged.",
      );
    }
    return;
  }
  const idx = SUCCESS_CHAIN_ORDER.indexOf(next);
  if (idx < 0) {
    throw new CursorProvenanceError(
      "cursor_provenance_event_divergence",
      `Unsupported transition kind ordering: ${next}`,
    );
  }
  if (idx === 0) {
    if (existingKinds.size > 0) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "issue_create_intent must be the first transition.",
      );
    }
    return;
  }
  const requiredPrior = SUCCESS_CHAIN_ORDER[idx - 1]!;
  if (!existingKinds.has(requiredPrior)) {
    throw new CursorProvenanceError(
      "cursor_provenance_event_divergence",
      `${next} requires prior ${requiredPrior}.`,
    );
  }
  // workflow/provider binding cannot precede trigger acknowledgement
  if (
    (next === "workflow_bound" || next === "provider_operation_bound") &&
    !existingKinds.has("trigger_acknowledged")
  ) {
    throw new CursorProvenanceError(
      "cursor_provenance_event_divergence",
      `${next} cannot precede trigger_acknowledged.`,
    );
  }
}

export async function appendDeterministicTransitionV2(input: {
  store: ProvenanceLifecycleStoreInterface;
  listPaths?: () => Promise<string[]>;
  recoveryOperationId: string;
  epochId: string;
  stage: string;
  ordinal: number;
  transitionKind: CanaryAttemptTransitionKindV2;
  publicSafePayload: Record<string, unknown>;
  recordedAt: string;
  contractVersion?: string;
}): Promise<{ path: string; record: CanaryAttemptTransitionV2Record; idempotent: boolean }> {
  const state = await readCanaryStageChainV2({
    store: input.store,
    listPaths: input.listPaths,
    recoveryOperationId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
  });
  const payloadDigest = createHash("sha256")
    .update(stableStringify(input.publicSafePayload), "utf8")
    .digest("hex");

  const existingSameKind = state.transitions.filter(
    (t) => t.ordinal === input.ordinal && t.transitionKind === input.transitionKind,
  );
  if (existingSameKind.length > 1) {
    throw new CursorProvenanceError(
      "cursor_provenance_event_divergence",
      "Multiple transitions exist for the same kind (v2).",
    );
  }
  if (existingSameKind.length === 1) {
    const existing = existingSameKind[0]!;
    if (existing.payloadDigest !== payloadDigest) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "Existing transition payload conflicts with intended payload.",
      );
    }
    const path = recoveryAttemptTransitionRemotePath({
      recoveryOpId: input.recoveryOperationId,
      epochId: input.epochId,
      stage: input.stage,
      ordinal: input.ordinal,
      transitionId: existing.transitionId,
    });
    return { path, record: existing, idempotent: true };
  }

  const existingKinds = new Set(
    state.transitions
      .filter((t) => t.ordinal === input.ordinal)
      .map((t) => t.transitionKind),
  );
  assertLegalNextTransition({
    existingKinds,
    next: input.transitionKind,
  });

  const { tail } = chainForOrdinal(state.transitions, input.ordinal);
  const transitionId = deriveTransitionId({
    recoveryOperationId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
    ordinal: input.ordinal,
    transitionKind: input.transitionKind,
    payloadDigest,
    previousTransitionDigest: tail?.transitionDigest ?? null,
  });
  const record = buildCanaryAttemptTransitionV2Record({
    recoveryOperationId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
    ordinal: input.ordinal,
    transitionId,
    transitionKind: input.transitionKind,
    previousTransitionId: tail?.transitionId ?? null,
    previousTransitionDigest: tail?.transitionDigest ?? null,
    recordedAt: input.recordedAt,
    publicSafePayload: input.publicSafePayload,
    contractVersion: input.contractVersion,
  });
  const path = recoveryAttemptTransitionRemotePath({
    recoveryOpId: input.recoveryOperationId,
    epochId: input.epochId,
    stage: input.stage,
    ordinal: input.ordinal,
    transitionId,
  });

  const existing = await input.store.loadRecord(path);
  if (existing) {
    const parsed = parseCanaryAttemptTransitionV2Record(existing);
    const matches =
      parsed.transitionKind === input.transitionKind &&
      parsed.payloadDigest === payloadDigest &&
      parsed.previousTransitionId === (tail?.transitionId ?? null) &&
      parsed.previousTransitionDigest === (tail?.transitionDigest ?? null);
    if (!matches) {
      throw new CursorProvenanceError(
        "cursor_provenance_event_divergence",
        "Existing transition conflicts with intended successor.",
      );
    }
    return { path, record: parsed, idempotent: true };
  }

  const body = `${JSON.stringify(record, null, 2)}\n`;
  try {
    const result = await input.store.persistImmutableRecord({
      path,
      body,
      canonicalDigest: record.transitionDigest,
      commitMessage: `p-dev: canary transition ${record.transitionKind}`,
    });
    return { path, record, idempotent: result.idempotent };
  } catch (error) {
    // Lost-response / race adoption: re-read and accept matching successor.
    const raced = await input.store.loadRecord(path);
    if (raced) {
      const parsed = parseCanaryAttemptTransitionV2Record(raced);
      const matches =
        parsed.transitionKind === input.transitionKind &&
        parsed.payloadDigest === payloadDigest &&
        parsed.previousTransitionId === (tail?.transitionId ?? null) &&
        parsed.previousTransitionDigest === (tail?.transitionDigest ?? null);
      if (matches) {
        return { path, record: parsed, idempotent: true };
      }
    }
    throw error;
  }
}

