/**
 * Reconciler operational health: heartbeat persistence + stale thresholds.
 *
 * GitHub Actions `schedule` is best-effort; a missing reconciler must not be silent.
 */

import type { WorkflowStateRecord } from "./state/types.js";

export const RECONCILE_HEARTBEAT_KIND = "p-dev.reconcile-heartbeat.v1" as const;
export const RECONCILE_HEARTBEAT_PATH = ".p-dev/reconcile-heartbeat.json";

/** Declared cron is every 15 minutes; allow 3x slack for GitHub schedule delay. */
export const RECONCILE_HEARTBEAT_STALE_MS = 45 * 60 * 1000;

/** Plan Review / agent phase without claim or agent progress. */
export const AUTOMATED_PHASE_STALE_WARNING_MS = 90 * 60 * 1000;

/** Exhausted automatic start recovery → Blocked projection. */
export const AUTOMATED_PHASE_STALE_BLOCKED_MS = 180 * 60 * 1000;

/** Max opaque HTTP dispatch attempts per plan_review_dispatch effect. */
export const PLAN_REVIEW_DISPATCH_MAX_ATTEMPTS = 3;

/** Max opaque HTTP dispatch attempts per implementation_dispatch effect. */
export const IMPLEMENTATION_DISPATCH_MAX_ATTEMPTS = 3;

/** Max claim_lost reload/retries for code_review_dispatch CAS races. */
export const CODE_REVIEW_DISPATCH_MAX_CLAIM_RETRIES = 3;

export const RECONCILE_WORKFLOW_RELATIVE_PATH =
  ".github/workflows/harness-reconcile-revisions.yml";

export const RECONCILE_WORKFLOW_REQUIRED_CRON = "*/15 * * * *";

export const RECONCILE_WORKFLOW_REQUIRED_COMMAND =
  "harness:reconcile-workflow";

export type ReconcileHeartbeatFailureClassification =
  | "command_failure"
  | "dispatch_failure"
  | "schedule_gap"
  | "unknown";

export interface ReconcileHeartbeatRecord {
  kind: typeof RECONCILE_HEARTBEAT_KIND;
  /** @deprecated Prefer lastAttemptFinishedAt; kept for compat. */
  finishedAt: string;
  workflowRunId: string | null;
  candidatesFound: number;
  opaqueDispatches: number;
  legacyDispatchForbidden: true;
  statusesScanned: string[];
  /** Whether this scan requested repository_dispatch. */
  dispatchEnabled?: boolean;
  /** Terminal scan outcome for doctor/ops. */
  outcome?: "success" | "failure" | "dry_run";
  /** Alias of outcome for clearer diagnostics. */
  lastOutcome?: "success" | "failure" | "dry_run";
  /** Last failure message when outcome=failure (bounded). */
  lastFailure?: string | null;
  /** ISO timestamp of the last successful (non-failure) scan. */
  lastSuccessfulScanAt?: string | null;
  /** When the reconcile attempt began. */
  lastAttemptStartedAt?: string | null;
  /** When the reconcile attempt finished (same as finishedAt when written). */
  lastAttemptFinishedAt?: string | null;
  /** Last GitHub Actions run id that wrote this heartbeat. */
  lastWorkflowRunId?: string | null;
  /** Classified failure mode for doctor/ops. */
  lastFailureClassification?: ReconcileHeartbeatFailureClassification | null;
}

export type ReconcileHeartbeatHealth =
  | { ok: true; ageMs: number; heartbeat: ReconcileHeartbeatRecord }
  | {
      ok: false;
      reason: "missing" | "stale" | "invalid";
      ageMs: number | null;
      heartbeat: ReconcileHeartbeatRecord | null;
      detail: string;
    };

export function buildReconcileHeartbeat(input: {
  finishedAt?: string;
  workflowRunId?: string | null;
  candidatesFound: number;
  opaqueDispatches: number;
  statusesScanned: string[];
  dispatchEnabled?: boolean;
  outcome?: "success" | "failure" | "dry_run";
  lastFailure?: string | null;
  lastSuccessfulScanAt?: string | null;
  lastAttemptStartedAt?: string | null;
  lastAttemptFinishedAt?: string | null;
  lastFailureClassification?: ReconcileHeartbeatFailureClassification | null;
}): ReconcileHeartbeatRecord {
  const finishedAt =
    input.lastAttemptFinishedAt ??
    input.finishedAt ??
    new Date().toISOString();
  const outcome = input.outcome ?? "success";
  const workflowRunId = input.workflowRunId ?? process.env.GITHUB_RUN_ID ?? null;
  return {
    kind: RECONCILE_HEARTBEAT_KIND,
    finishedAt,
    workflowRunId,
    candidatesFound: input.candidatesFound,
    opaqueDispatches: input.opaqueDispatches,
    legacyDispatchForbidden: true,
    statusesScanned: [...input.statusesScanned],
    dispatchEnabled: input.dispatchEnabled ?? false,
    outcome,
    lastOutcome: outcome,
    lastFailure: input.lastFailure ?? null,
    lastSuccessfulScanAt:
      input.lastSuccessfulScanAt === undefined
        ? outcome === "failure"
          ? null
          : finishedAt
        : input.lastSuccessfulScanAt,
    lastAttemptStartedAt: input.lastAttemptStartedAt ?? null,
    lastAttemptFinishedAt: finishedAt,
    lastWorkflowRunId: workflowRunId,
    lastFailureClassification:
      input.lastFailureClassification ??
      (outcome === "failure" ? "command_failure" : null),
  };
}

export function parseReconcileHeartbeat(
  raw: unknown,
): ReconcileHeartbeatRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== RECONCILE_HEARTBEAT_KIND) return null;
  if (typeof obj.finishedAt !== "string" || !obj.finishedAt.trim()) return null;
  if (typeof obj.candidatesFound !== "number") return null;
  if (typeof obj.opaqueDispatches !== "number") return null;
  if (obj.legacyDispatchForbidden !== true) return null;
  if (!Array.isArray(obj.statusesScanned)) return null;
  const outcome =
    obj.outcome === "success" ||
    obj.outcome === "failure" ||
    obj.outcome === "dry_run"
      ? obj.outcome
      : undefined;
  const failureClassification =
    obj.lastFailureClassification === "command_failure" ||
    obj.lastFailureClassification === "dispatch_failure" ||
    obj.lastFailureClassification === "schedule_gap" ||
    obj.lastFailureClassification === "unknown" ||
    obj.lastFailureClassification === null
      ? (obj.lastFailureClassification as
          | ReconcileHeartbeatFailureClassification
          | null)
      : undefined;
  const lastOutcome =
    obj.lastOutcome === "success" ||
    obj.lastOutcome === "failure" ||
    obj.lastOutcome === "dry_run"
      ? obj.lastOutcome
      : outcome;
  return {
    kind: RECONCILE_HEARTBEAT_KIND,
    finishedAt: obj.finishedAt,
    workflowRunId:
      typeof obj.workflowRunId === "string" || obj.workflowRunId === null
        ? (obj.workflowRunId as string | null)
        : null,
    candidatesFound: obj.candidatesFound,
    opaqueDispatches: obj.opaqueDispatches,
    legacyDispatchForbidden: true,
    statusesScanned: obj.statusesScanned.filter(
      (s): s is string => typeof s === "string",
    ),
    ...(typeof obj.dispatchEnabled === "boolean"
      ? { dispatchEnabled: obj.dispatchEnabled }
      : {}),
    ...(outcome ? { outcome } : {}),
    ...(lastOutcome ? { lastOutcome } : {}),
    ...(obj.lastFailure === null || typeof obj.lastFailure === "string"
      ? { lastFailure: obj.lastFailure as string | null }
      : {}),
    ...(obj.lastSuccessfulScanAt === null ||
    typeof obj.lastSuccessfulScanAt === "string"
      ? { lastSuccessfulScanAt: obj.lastSuccessfulScanAt as string | null }
      : {}),
    ...(obj.lastAttemptStartedAt === null ||
    typeof obj.lastAttemptStartedAt === "string"
      ? { lastAttemptStartedAt: obj.lastAttemptStartedAt as string | null }
      : {}),
    ...(obj.lastAttemptFinishedAt === null ||
    typeof obj.lastAttemptFinishedAt === "string"
      ? { lastAttemptFinishedAt: obj.lastAttemptFinishedAt as string | null }
      : { lastAttemptFinishedAt: obj.finishedAt }),
    ...(obj.lastWorkflowRunId === null ||
    typeof obj.lastWorkflowRunId === "string"
      ? { lastWorkflowRunId: obj.lastWorkflowRunId as string | null }
      : {
          lastWorkflowRunId:
            typeof obj.workflowRunId === "string" || obj.workflowRunId === null
              ? (obj.workflowRunId as string | null)
              : null,
        }),
    ...(failureClassification !== undefined
      ? { lastFailureClassification: failureClassification }
      : {}),
  };
}

export function evaluateReconcileHeartbeatHealth(
  heartbeat: ReconcileHeartbeatRecord | null,
  nowMs = Date.now(),
  staleMs = RECONCILE_HEARTBEAT_STALE_MS,
): ReconcileHeartbeatHealth {
  if (!heartbeat) {
    return {
      ok: false,
      reason: "missing",
      ageMs: null,
      heartbeat: null,
      detail:
        "No reconcile heartbeat found. Scheduled harness:reconcile-workflow may be missing, disabled, or not writing heartbeats.",
    };
  }
  const finished = Date.parse(heartbeat.finishedAt);
  if (!Number.isFinite(finished)) {
    return {
      ok: false,
      reason: "invalid",
      ageMs: null,
      heartbeat,
      detail: "Reconcile heartbeat finishedAt is not a valid timestamp.",
    };
  }
  const ageMs = nowMs - finished;
  if (ageMs > staleMs) {
    const classification =
      heartbeat.lastFailureClassification === "command_failure"
        ? "command_failure"
        : "schedule_gap";
    return {
      ok: false,
      reason: "stale",
      ageMs,
      heartbeat: {
        ...heartbeat,
        lastFailureClassification:
          heartbeat.lastFailureClassification ?? classification,
      },
      detail: `Reconcile heartbeat is ${Math.round(ageMs / 60000)}m old (threshold ${Math.round(staleMs / 60000)}m). Classification=${classification}. GitHub schedule ticks may be delayed or dropped.`,
    };
  }
  return { ok: true, ageMs, heartbeat };
}

export type AutomatedPhaseStaleLevel = "ok" | "warning" | "blocked_candidate";

export function evaluateAutomatedPhaseStaleness(input: {
  state: WorkflowStateRecord;
  nowMs?: number;
  warningMs?: number;
  blockedMs?: number;
}): {
  level: AutomatedPhaseStaleLevel;
  ageMs: number | null;
  phaseId: string | null;
  detail: string;
} {
  const nowMs = input.nowMs ?? Date.now();
  const warningMs = input.warningMs ?? AUTOMATED_PHASE_STALE_WARNING_MS;
  const blockedMs = input.blockedMs ?? AUTOMATED_PHASE_STALE_BLOCKED_MS;
  const phaseId = input.state.currentPhaseId;
  const agentPhases = new Set(["plan_review", "code_review", "code_revision"]);
  if (!phaseId || !agentPhases.has(phaseId)) {
    return {
      level: "ok",
      ageMs: null,
      phaseId,
      detail: "Phase is not an automated review phase.",
    };
  }

  const hasProgress =
    Boolean(input.state.activeRunLease) ||
    Boolean(input.state.planReviewerAgentId) ||
    Boolean(
      input.state.planReviewSubjectIdentity &&
        input.state.acceptedReviewSubjects?.[
          input.state.planReviewSubjectIdentity
        ],
    ) ||
    Boolean(
      input.state.activeReviewSubjectIdentity &&
        input.state.acceptedReviewSubjects?.[
          input.state.activeReviewSubjectIdentity
        ],
    );

  if (hasProgress) {
    return {
      level: "ok",
      ageMs: null,
      phaseId,
      detail: "Automated phase has claim, agent, or accepted decision progress.",
    };
  }

  const anchor =
    input.state.sideEffects?.find(
      (e) =>
        e.kind === "plan_review_dispatch" ||
        e.kind === "code_review_dispatch" ||
        e.kind === "implementation_dispatch",
    )?.createdAt ??
    input.state.lastTransitionAt;

  if (!anchor) {
    return {
      level: "warning",
      ageMs: null,
      phaseId,
      detail: `Automated phase ${phaseId} has no progress anchor (missing transition/effect timestamps).`,
    };
  }

  const ageMs = nowMs - Date.parse(anchor);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return {
      level: "warning",
      ageMs: null,
      phaseId,
      detail: `Automated phase ${phaseId} has an invalid progress anchor timestamp.`,
    };
  }

  if (ageMs >= blockedMs) {
    return {
      level: "blocked_candidate",
      ageMs,
      phaseId,
      detail: `Automated phase ${phaseId} has had no claim/agent/decision for ${Math.round(ageMs / 60000)}m (Blocked threshold ${Math.round(blockedMs / 60000)}m).`,
    };
  }
  if (ageMs >= warningMs) {
    return {
      level: "warning",
      ageMs,
      phaseId,
      detail: `Automated phase ${phaseId} has had no claim/agent/decision for ${Math.round(ageMs / 60000)}m (warning threshold ${Math.round(warningMs / 60000)}m).`,
    };
  }
  return {
    level: "ok",
    ageMs,
    phaseId,
    detail: `Automated phase ${phaseId} is within stale thresholds.`,
  };
}

export function inspectReconcileWorkflowSource(content: string): {
  hasSchedule: boolean;
  hasRequiredCron: boolean;
  invokesReconcileCommand: boolean;
  detail: string;
} {
  const hasSchedule = /^\s*schedule\s*:/m.test(content) || /\bon:\s*[\s\S]*schedule\s*:/m.test(content);
  const hasRequiredCron = content.includes(RECONCILE_WORKFLOW_REQUIRED_CRON);
  const invokesReconcileCommand =
    content.includes(RECONCILE_WORKFLOW_REQUIRED_COMMAND) ||
    content.includes("harness:reconcile-workflow");
  const ok = hasSchedule && hasRequiredCron && invokesReconcileCommand;
  return {
    hasSchedule,
    hasRequiredCron,
    invokesReconcileCommand,
    detail: ok
      ? "Reconcile workflow declares */15 schedule and invokes harness:reconcile-workflow."
      : `Reconcile workflow incomplete: schedule=${hasSchedule}, cron=${hasRequiredCron}, command=${invokesReconcileCommand}.`,
  };
}
