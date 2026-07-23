import { randomBytes } from "node:crypto";
import type { CursorUsageDiscoveryErrorCode } from "./discovery-config.js";

export type PreflightOperationState =
  | "queued"
  | "running"
  | "committing"
  | "succeeded"
  | "failed"
  | "cancelled";

export type PreflightOperationPhase =
  | "source_inspection"
  | "trace_retrieval"
  | "observation_retrieval"
  | "candidate_construction"
  | "attribution"
  | "staging"
  | "committing";

export interface PreflightOperationPublicStatus {
  operationId: string;
  state: PreflightOperationState;
  phase: PreflightOperationPhase | null;
  elapsedMs: number;
  tracePagesFetched: number;
  tracesFetched: number;
  observationPagesFetched: number;
  observationsFetched: number;
  targetObservationsRetained: number;
  knownTotalPages: number | null;
  /** True after DELETE ack while discovery is still settling (nonterminal). */
  cancelRequested: boolean;
  errorCode: CursorUsageDiscoveryErrorCode | string | null;
  errorMessage: string | null;
  /** Present only when succeeded. */
  result?: Record<string, unknown> | null;
}

type InternalOp = {
  operationId: string;
  workspaceIdentity: string;
  createdAtMs: number;
  startedAtMs: number | null;
  state: PreflightOperationState;
  phase: PreflightOperationPhase | null;
  controller: AbortController;
  csvBytes: Buffer | null;
  cancelRequested: boolean;
  progress: {
    tracePagesFetched: number;
    tracesFetched: number;
    observationPagesFetched: number;
    observationsFetched: number;
    targetObservationsRetained: number;
    knownTotalPages: number | null;
  };
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  commitStarted: boolean;
  /** Keeps the background preflight Promise strongly referenced for process lifetime. */
  work: Promise<void> | null;
};

const TTL_MS = 15 * 60 * 1000;
const ops = new Map<string, InternalOp>();

const TERMINAL_STATES = new Set<PreflightOperationState>([
  "succeeded",
  "failed",
  "cancelled",
]);

function isTerminal(state: PreflightOperationState): boolean {
  return TERMINAL_STATES.has(state);
}

function newOperationId(): string {
  return randomBytes(24).toString("base64url");
}

function purgeExpired(now = Date.now()): void {
  for (const [id, op] of ops) {
    if (now - op.createdAtMs > TTL_MS) {
      op.csvBytes = null;
      ops.delete(id);
    }
  }
}

export function createPreflightOperation(params: {
  workspaceIdentity: string;
  csvBytes: Buffer;
}): { operationId: string; controller: AbortController } {
  purgeExpired();
  const operationId = newOperationId();
  const controller = new AbortController();
  ops.set(operationId, {
    operationId,
    workspaceIdentity: params.workspaceIdentity,
    createdAtMs: Date.now(),
    startedAtMs: null,
    state: "queued",
    phase: "source_inspection",
    controller,
    csvBytes: params.csvBytes,
    cancelRequested: false,
    progress: {
      tracePagesFetched: 0,
      tracesFetched: 0,
      observationPagesFetched: 0,
      observationsFetched: 0,
      targetObservationsRetained: 0,
      knownTotalPages: null,
    },
    errorCode: null,
    errorMessage: null,
    result: null,
    commitStarted: false,
    work: null,
  });
  return { operationId, controller };
}

/** Attach background work so Node/Next keep the Promise alive after 202. */
export function attachPreflightWork(
  operationId: string,
  work: Promise<void>,
): void {
  const op = ops.get(operationId);
  if (!op) return;
  op.work = work.finally(() => {
    const current = ops.get(operationId);
    if (current) current.work = null;
  });
}

export function getPreflightOperation(
  operationId: string,
  workspaceIdentity: string,
): InternalOp | null {
  purgeExpired();
  const op = ops.get(operationId);
  if (!op) return null;
  if (op.workspaceIdentity !== workspaceIdentity) return null;
  return op;
}

export function markPreflightRunning(operationId: string): void {
  const op = ops.get(operationId);
  if (!op) return;
  if (isTerminal(op.state) || op.state === "committing") return;
  op.state = "running";
  op.startedAtMs = Date.now();
}

export function updatePreflightProgress(
  operationId: string,
  patch: Partial<InternalOp["progress"]> & { phase?: PreflightOperationPhase },
): void {
  const op = ops.get(operationId);
  if (!op) return;
  if (isTerminal(op.state)) return;
  if (patch.phase) op.phase = patch.phase;
  const { phase: _p, ...rest } = patch;
  Object.assign(op.progress, rest);
}

export function beginPreflightCommit(operationId: string): boolean {
  const op = ops.get(operationId);
  if (!op) return false;
  if (op.controller.signal.aborted || op.cancelRequested || op.state === "cancelled") {
    return false;
  }
  if (isTerminal(op.state)) return false;
  if (op.state !== "queued" && op.state !== "running") return false;
  op.commitStarted = true;
  op.state = "committing";
  op.phase = "committing";
  // Release CSV bytes at successful commit start.
  op.csvBytes = null;
  return true;
}

export function completePreflightSuccess(
  operationId: string,
  result: Record<string, unknown>,
): void {
  const op = ops.get(operationId);
  if (!op) return;
  // Terminal monotonicity: late success cannot replace failed/cancelled.
  if (isTerminal(op.state)) return;
  // Success is only valid from queued/running/committing (commit path).
  if (
    op.state !== "queued" &&
    op.state !== "running" &&
    op.state !== "committing"
  ) {
    return;
  }
  // Cancellation request wins over a racing success.
  if (op.cancelRequested) {
    op.state = "cancelled";
    op.errorCode = "langfuse_discovery_cancelled";
    op.errorMessage = "Langfuse discovery was cancelled.";
    op.csvBytes = null;
    op.phase = null;
    op.result = null;
    return;
  }
  op.state = "succeeded";
  op.result = result;
  op.csvBytes = null;
  op.phase = null;
}

export function completePreflightFailure(
  operationId: string,
  code: string,
  message: string,
): void {
  const op = ops.get(operationId);
  if (!op) return;

  // Terminal monotonicity: never leave succeeded/failed/cancelled.
  if (isTerminal(op.state)) return;

  const isCancelCode = code === "langfuse_discovery_cancelled";
  const treatAsCancel = op.cancelRequested || isCancelCode;

  if (treatAsCancel) {
    // From committing, cancel is too late — only succeeded|failed allowed.
    if (op.state === "committing") {
      op.state = "failed";
      op.errorCode = code === "langfuse_discovery_cancelled"
        ? "preflight_failed"
        : code;
      op.errorMessage = message;
      op.csvBytes = null;
      return;
    }
    op.state = "cancelled";
    // Preserve original cancellation details; never replace with SDK retrieval text.
    op.errorCode = "langfuse_discovery_cancelled";
    op.errorMessage = "Langfuse discovery was cancelled.";
    op.csvBytes = null;
    return;
  }

  if (op.state === "queued" || op.state === "running" || op.state === "committing") {
    op.state = "failed";
    op.errorCode = code;
    op.errorMessage = message;
    op.csvBytes = null;
  }
}

export function requestPreflightCancel(
  operationId: string,
  workspaceIdentity: string,
):
  | { ok: true; alreadyTerminal: boolean }
  | { ok: false; code: "cursor_usage_preflight_operation_not_found" }
  | { ok: false; code: "cursor_usage_preflight_cancel_too_late" } {
  const op = getPreflightOperation(operationId, workspaceIdentity);
  if (!op) {
    return { ok: false, code: "cursor_usage_preflight_operation_not_found" };
  }
  if (op.commitStarted || op.state === "committing") {
    return { ok: false, code: "cursor_usage_preflight_cancel_too_late" };
  }
  if (isTerminal(op.state)) {
    return { ok: true, alreadyTerminal: true };
  }
  // Acknowledge cancellation without publishing terminal cancelled yet.
  op.cancelRequested = true;
  op.controller.abort(new Error("langfuse_discovery_cancelled"));
  op.errorCode = "langfuse_discovery_cancelled";
  op.errorMessage = "Langfuse discovery was cancelled.";
  op.csvBytes = null;
  return { ok: true, alreadyTerminal: false };
}

export function toPublicStatus(op: InternalOp): PreflightOperationPublicStatus {
  const started = op.startedAtMs ?? op.createdAtMs;
  return {
    operationId: op.operationId,
    state: op.state,
    phase: op.phase,
    elapsedMs: Math.max(0, Date.now() - started),
    tracePagesFetched: op.progress.tracePagesFetched,
    tracesFetched: op.progress.tracesFetched,
    observationPagesFetched: op.progress.observationPagesFetched,
    observationsFetched: op.progress.observationsFetched,
    targetObservationsRetained: op.progress.targetObservationsRetained,
    knownTotalPages: op.progress.knownTotalPages,
    cancelRequested: op.cancelRequested,
    errorCode: op.errorCode,
    errorMessage: op.errorMessage,
    result: op.state === "succeeded" ? op.result : null,
  };
}

export function takePreflightCsvBytes(operationId: string): Buffer | null {
  const op = ops.get(operationId);
  if (!op || !op.csvBytes) return null;
  const bytes = op.csvBytes;
  op.csvBytes = null;
  return bytes;
}

/** Test helper */
export function resetPreflightOperationsForTests(): void {
  ops.clear();
}

/** Test helper — inspect internal cancelRequested / work without publishing secrets. */
export function getPreflightOperationForTests(
  operationId: string,
): InternalOp | null {
  return ops.get(operationId) ?? null;
}
