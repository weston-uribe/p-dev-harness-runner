/**
 * Stop-after-planning execution policy: label claim, freeze CAS, and terminalization.
 */

import { createHash } from "node:crypto";
import { CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES } from "./canonical-product-development-workflow.js";
import type { PlanArtifactIdentity } from "./plan-artifact.js";
import {
  DEFAULT_WORKFLOW_STATE_MAX_RETRIES,
  decideConflictRetry,
} from "./state/conflict.js";
import {
  DurableStateCasExhaustedError,
  DurableStateUnavailableError,
} from "./state/production-completion-cas.js";
import type { WorkflowStateStore } from "./state/store.js";
import { markSideEffectCompleted } from "./state/side-effects.js";
import type {
  ExecutionPolicyFreeze,
  ExecutionPolicyKind,
  ExecutionPolicyResult,
  WorkflowStateRecord,
} from "./state/types.js";
import {
  EXECUTION_POLICY_SCHEMA_VERSION,
  createEmptyWorkflowState,
} from "./state/types.js";
import { applyWorkflowTransition } from "./state/apply.js";
import type { TransitionResult } from "./transition-engine.js";
import type { ResolvedWorkflowDefinition } from "./definition/types.js";

export const EXECUTION_POLICY_LABEL_NAMESPACE = "p-dev-execution-policy:";
export const STOP_AFTER_PLANNING_LABEL =
  "p-dev-execution-policy:stop-after-planning";
export const TERMINAL_STATUS_CANONICAL_NAME = "Canceled";

export type ExecutionPolicyErrorCode =
  | "missing_ingress_identity"
  | "unknown_policy_label"
  | "multiple_policy_labels"
  | "conflicting_policy_label"
  | "missing_terminal_status"
  | "ambiguous_terminal_status"
  | "terminal_status_is_dispatch_trigger"
  | "terminal_status_invalidated"
  | "policy_conflict"
  | "policy_schema_mismatch"
  | "workflow_schema_mismatch"
  | "unsupported_team";

export class ExecutionPolicyError extends Error {
  readonly code: ExecutionPolicyErrorCode;

  constructor(code: ExecutionPolicyErrorCode, message: string) {
    super(message);
    this.name = "ExecutionPolicyError";
    this.code = code;
  }
}

export interface LinearWorkflowStateRef {
  id: string;
  name: string;
}

function normalizeLabelName(name: string): string {
  return name.trim().toLowerCase();
}

export function computeExecutionPolicyIdentity(input: {
  schemaVersion: string;
  policyKind: ExecutionPolicyKind;
  linearTeamId: string;
  issueInternalId: string;
  issueKey: string;
  sourceLabelId: string;
  sourceLabelName: string;
  terminalStatusId: string;
  terminalStatusName: string;
  workflowSchemaVersion: string;
}): string {
  const lines = [
    `schemaVersion=${input.schemaVersion}`,
    `policyKind=${input.policyKind}`,
    `linearTeamId=${input.linearTeamId}`,
    `issueInternalId=${input.issueInternalId}`,
    `issueKey=${input.issueKey}`,
    `sourceLabelId=${input.sourceLabelId}`,
    `sourceLabelName=${input.sourceLabelName}`,
    `terminalStatusId=${input.terminalStatusId}`,
    `terminalStatusName=${input.terminalStatusName}`,
    `workflowSchemaVersion=${input.workflowSchemaVersion}`,
  ];
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

export function resolveReservedExecutionPolicyLabels(
  labels: Array<{ id: string; name: string }>,
): {
  reserved: Array<{ id: string; name: string }>;
  supported: { id: string; name: string } | null;
} {
  const reserved = labels.filter((label) =>
    normalizeLabelName(label.name).startsWith(
      normalizeLabelName(EXECUTION_POLICY_LABEL_NAMESPACE),
    ),
  );
  const supportedMatches = reserved.filter(
    (label) =>
      normalizeLabelName(label.name) ===
      normalizeLabelName(STOP_AFTER_PLANNING_LABEL),
  );
  const supported =
    supportedMatches.length === 1
      ? { id: supportedMatches[0]!.id, name: STOP_AFTER_PLANNING_LABEL }
      : null;
  return { reserved, supported };
}

export function resolveCanceledTerminalStatus(
  teamStates: readonly LinearWorkflowStateRef[],
  dispatchTriggerNames: readonly string[] = CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES,
): { id: string; name: string } {
  const dispatchNormalized = new Set(
    dispatchTriggerNames.map((name) => normalizeLabelName(name)),
  );
  const canceledMatches = teamStates.filter(
    (state) =>
      normalizeLabelName(state.name) ===
      normalizeLabelName(TERMINAL_STATUS_CANONICAL_NAME),
  );
  if (canceledMatches.length === 0) {
    throw new ExecutionPolicyError(
      "missing_terminal_status",
      `Linear team is missing a "${TERMINAL_STATUS_CANONICAL_NAME}" workflow state`,
    );
  }
  if (canceledMatches.length > 1) {
    throw new ExecutionPolicyError(
      "ambiguous_terminal_status",
      `Linear team has multiple "${TERMINAL_STATUS_CANONICAL_NAME}" workflow states`,
    );
  }
  const match = canceledMatches[0]!;
  if (dispatchNormalized.has(normalizeLabelName(match.name))) {
    throw new ExecutionPolicyError(
      "terminal_status_is_dispatch_trigger",
      `Terminal status "${match.name}" must not be a dispatch trigger`,
    );
  }
  return { id: match.id, name: match.name };
}

export function revalidateFrozenTerminalStatus(
  teamStates: readonly LinearWorkflowStateRef[],
  freezeOrTerminalStatusId:
    | Pick<ExecutionPolicyFreeze, "terminalStatusId" | "terminalStatusName">
    | string,
  dispatchTriggerNames: readonly string[] = CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES,
): void {
  const frozenTerminalStatusId =
    typeof freezeOrTerminalStatusId === "string"
      ? freezeOrTerminalStatusId
      : freezeOrTerminalStatusId.terminalStatusId;
  const frozenTerminalStatusName =
    typeof freezeOrTerminalStatusId === "string"
      ? null
      : freezeOrTerminalStatusId.terminalStatusName;

  const state = teamStates.find((s) => s.id === frozenTerminalStatusId);
  if (!state) {
    throw new ExecutionPolicyError(
      "terminal_status_invalidated",
      `Frozen terminal status id ${frozenTerminalStatusId} no longer exists on team`,
    );
  }
  if (
    frozenTerminalStatusName !== null &&
    state.name !== frozenTerminalStatusName
  ) {
    throw new ExecutionPolicyError(
      "terminal_status_invalidated",
      `Frozen terminal status id ${frozenTerminalStatusId} was renamed from "${frozenTerminalStatusName}" to "${state.name}"`,
    );
  }
  if (
    normalizeLabelName(state.name) !==
    normalizeLabelName(TERMINAL_STATUS_CANONICAL_NAME)
  ) {
    throw new ExecutionPolicyError(
      "terminal_status_invalidated",
      `Frozen terminal status "${state.name}" is no longer canonical "${TERMINAL_STATUS_CANONICAL_NAME}"`,
    );
  }
  const dispatchNormalized = new Set(
    dispatchTriggerNames.map((name) => normalizeLabelName(name)),
  );
  if (dispatchNormalized.has(normalizeLabelName(state.name))) {
    throw new ExecutionPolicyError(
      "terminal_status_invalidated",
      `Frozen terminal status "${state.name}" is now a dispatch trigger`,
    );
  }
}

export function resolveAuthoritativeLinearDeliveryId(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = env.LINEAR_DELIVERY_ID?.trim();
  return value || null;
}

export function buildPlanningOnlyTerminalEffectIdentity(
  policyIdentity: string,
): string {
  return `planning_only_terminal_transition:${policyIdentity}`;
}

export function isPlanningOnlySuppressed(state: WorkflowStateRecord): boolean {
  const freeze = state.executionPolicyFreeze;
  if (!freeze || freeze.policyKind !== "stop_after_planning") {
    return false;
  }
  if (state.planningOnlyDownstreamSuppressed) {
    return true;
  }
  const result = state.executionPolicyResult;
  return (
    result?.kind === "terminalization_pending" || result?.kind === "terminalized"
  );
}

export type ClaimOrAdoptExecutionPolicyResult =
  | { kind: "none" }
  | { kind: "claimed"; freeze: ExecutionPolicyFreeze }
  | { kind: "adopted"; freeze: ExecutionPolicyFreeze }
  | { kind: "already_terminalized"; freeze: ExecutionPolicyFreeze };

export function claimOrAdoptExecutionPolicyFreeze(input: {
  issueKey: string;
  issueInternalId: string;
  linearTeamId: string;
  labels: Array<{ id: string; name: string }>;
  teamStates: readonly LinearWorkflowStateRef[];
  workflowSchemaVersion: string;
  linearDeliveryId: string | null;
  firstPlanningRunId: string;
  existingFreeze: ExecutionPolicyFreeze | null | undefined;
  existingResult: ExecutionPolicyResult | null | undefined;
  now?: () => string;
}): ClaimOrAdoptExecutionPolicyResult {
  const now = input.now ?? (() => new Date().toISOString());
  const { reserved, supported } = resolveReservedExecutionPolicyLabels(
    input.labels,
  );

  if (!input.existingFreeze) {
    if (reserved.length === 0) {
      return { kind: "none" };
    }
    if (!supported) {
      if (reserved.length > 1) {
        throw new ExecutionPolicyError(
          "multiple_policy_labels",
          "Multiple reserved execution policy labels are attached",
        );
      }
      throw new ExecutionPolicyError(
        "unknown_policy_label",
        `Unknown execution policy label: ${reserved[0]!.name}`,
      );
    }
    if (reserved.length > 1) {
      throw new ExecutionPolicyError(
        "multiple_policy_labels",
        "Multiple reserved execution policy labels are attached",
      );
    }
    if (!input.linearTeamId?.trim()) {
      throw new ExecutionPolicyError(
        "unsupported_team",
        "Issue is missing authoritative Linear team id for execution policy claim",
      );
    }
    const deliveryId = input.linearDeliveryId?.trim();
    if (!deliveryId) {
      throw new ExecutionPolicyError(
        "missing_ingress_identity",
        "LINEAR_DELIVERY_ID is required to claim stop-after-planning execution policy",
      );
    }
    const terminal = resolveCanceledTerminalStatus(input.teamStates);
    const policyIdentity = computeExecutionPolicyIdentity({
      schemaVersion: EXECUTION_POLICY_SCHEMA_VERSION,
      policyKind: "stop_after_planning",
      linearTeamId: input.linearTeamId,
      issueInternalId: input.issueInternalId,
      issueKey: input.issueKey,
      sourceLabelId: supported.id,
      sourceLabelName: supported.name,
      terminalStatusId: terminal.id,
      terminalStatusName: terminal.name,
      workflowSchemaVersion: input.workflowSchemaVersion,
    });
    const freeze: ExecutionPolicyFreeze = {
      schemaVersion: EXECUTION_POLICY_SCHEMA_VERSION,
      policyKind: "stop_after_planning",
      policyIdentity,
      linearTeamId: input.linearTeamId,
      issueInternalId: input.issueInternalId,
      issueKey: input.issueKey,
      sourceLabelId: supported.id,
      sourceLabelName: supported.name,
      terminalStatusId: terminal.id,
      terminalStatusName: terminal.name,
      workflowSchemaVersion: input.workflowSchemaVersion,
      firstClaim: {
        linearDeliveryId: deliveryId,
        claimedAt: now(),
        firstPlanningRunId: input.firstPlanningRunId,
      },
    };
    return { kind: "claimed", freeze };
  }

  const freeze = input.existingFreeze;
  if (freeze.schemaVersion !== EXECUTION_POLICY_SCHEMA_VERSION) {
    throw new ExecutionPolicyError(
      "policy_schema_mismatch",
      `Execution policy schema ${freeze.schemaVersion} does not match ${EXECUTION_POLICY_SCHEMA_VERSION}`,
    );
  }
  if (
    freeze.issueKey !== input.issueKey ||
    freeze.issueInternalId !== input.issueInternalId ||
    freeze.policyKind !== "stop_after_planning"
  ) {
    throw new ExecutionPolicyError(
      "policy_conflict",
      "Existing execution policy freeze does not match this issue",
    );
  }
  if (freeze.linearTeamId !== input.linearTeamId) {
    throw new ExecutionPolicyError(
      "unsupported_team",
      "Issue team does not match frozen execution policy team",
    );
  }
  if (freeze.workflowSchemaVersion !== input.workflowSchemaVersion) {
    throw new ExecutionPolicyError(
      "workflow_schema_mismatch",
      `Workflow schema ${input.workflowSchemaVersion} does not match frozen ${freeze.workflowSchemaVersion}`,
    );
  }

  if (reserved.length > 0) {
    if (reserved.length > 1) {
      throw new ExecutionPolicyError(
        "multiple_policy_labels",
        "Multiple reserved execution policy labels are attached",
      );
    }
    const label = reserved[0]!;
    const idAgrees = label.id === freeze.sourceLabelId;
    const nameAgrees =
      normalizeLabelName(label.name) ===
      normalizeLabelName(freeze.sourceLabelName);
    if (!idAgrees || !nameAgrees) {
      throw new ExecutionPolicyError(
        "conflicting_policy_label",
        `Attached policy label "${label.name}" (${label.id}) conflicts with frozen policy`,
      );
    }
    if (!supported) {
      throw new ExecutionPolicyError(
        "unknown_policy_label",
        `Unknown execution policy label: ${label.name}`,
      );
    }
  }

  revalidateFrozenTerminalStatus(input.teamStates, freeze);

  if (input.existingResult?.kind === "terminalized") {
    return { kind: "already_terminalized", freeze };
  }

  return { kind: "adopted", freeze };
}

export async function persistExecutionPolicyFreezeClaim(input: {
  store: WorkflowStateStore;
  issueKey: string;
  expectedRevision: number;
  freeze: ExecutionPolicyFreeze;
  maxRetries?: number;
}): Promise<WorkflowStateRecord> {
  const maxRetries =
    input.maxRetries ?? DEFAULT_WORKFLOW_STATE_MAX_RETRIES + 2;
  let attempt = 0;
  let expectedRevision = input.expectedRevision;

  while (attempt < maxRetries) {
    attempt += 1;
    const latest =
      (await input.store.load(input.issueKey)) ??
      createEmptyWorkflowState({
        issueKey: input.issueKey,
        workflowSchemaVersion: input.freeze.workflowSchemaVersion,
      });

    if (latest.stateRevision !== expectedRevision) {
      const existing = latest.executionPolicyFreeze;
      if (
        existing &&
        existing.policyIdentity === input.freeze.policyIdentity
      ) {
        return latest;
      }
      const decision = decideConflictRetry({
        attempt,
        maxRetries,
        casFailed: true,
      });
      if (!decision.retry) {
        throw new DurableStateCasExhaustedError();
      }
      expectedRevision = latest.stateRevision;
      continue;
    }

    if (latest.executionPolicyFreeze) {
      if (
        latest.executionPolicyFreeze.policyIdentity ===
        input.freeze.policyIdentity
      ) {
        return latest;
      }
      throw new ExecutionPolicyError(
        "policy_conflict",
        "Workflow state already has a different execution policy freeze",
      );
    }

    const next: WorkflowStateRecord = {
      ...latest,
      stateRevision: latest.stateRevision + 1,
      executionPolicyFreeze: input.freeze,
    };
    const saved = await input.store.compareAndSet({
      issueKey: input.issueKey,
      expectedRevision: latest.stateRevision,
      next,
    });
    if (saved) {
      return saved;
    }

    const decision = decideConflictRetry({
      attempt,
      maxRetries,
      casFailed: true,
    });
    if (!decision.retry) {
      throw new DurableStateCasExhaustedError();
    }
    const reloaded = await input.store.load(input.issueKey);
    expectedRevision = reloaded?.stateRevision ?? expectedRevision;
  }

  throw new DurableStateCasExhaustedError();
}

export async function applyPlanningOnlySuccessTransition(input: {
  store: WorkflowStateStore;
  issueKey: string;
  definition: ResolvedWorkflowDefinition;
  expectedStateRevision: number;
  freeze: ExecutionPolicyFreeze;
  planArtifact: PlanArtifactIdentity;
  planningRunId: string;
  planningStatusName: string;
  maxRetries?: number;
}): Promise<{ state: WorkflowStateRecord; transition: TransitionResult | null }> {
  const effectIdentity = buildPlanningOnlyTerminalEffectIdentity(
    input.freeze.policyIdentity,
  );
  const applied = await applyWorkflowTransition({
    store: input.store,
    issueKey: input.issueKey,
    definition: input.definition,
    expectedStateRevision: input.expectedStateRevision,
    currentPhaseId: "planning",
    outcome: {
      kind: "success",
      phaseId: "planning",
      attemptIdentity: input.planningRunId,
      generationId: input.planArtifact.planGenerationId,
    },
    evidence: { linearStatusName: input.planningStatusName },
    planningOnlyTerminalization: {
      freeze: input.freeze,
      planArtifact: input.planArtifact,
      planningRunId: input.planningRunId,
      terminalEffectIdentity: effectIdentity,
    },
    maxRetries: input.maxRetries,
  });

  if (applied.ok && applied.state) {
    return { state: applied.state, transition: applied.transition };
  }

  const latest = await input.store.load(input.issueKey);
  if (
    latest &&
    (latest.executionPolicyResult?.kind === "terminalization_pending" ||
      latest.executionPolicyResult?.kind === "terminalized") &&
    latest.executionPolicyResult.policyIdentity ===
      input.freeze.policyIdentity &&
    latest.planningOnlyDownstreamSuppressed
  ) {
    return { state: latest, transition: applied.transition };
  }

  throw new DurableStateCasExhaustedError(
    `Planning-only success transition failed: ${applied.reason}`,
  );
}

export async function completePlanningOnlyTerminalization(input: {
  store: WorkflowStateStore;
  issueKey: string;
  freeze: ExecutionPolicyFreeze;
  expectedStateRevision: number;
  maxRetries?: number;
  now?: () => string;
}): Promise<WorkflowStateRecord> {
  const maxRetries =
    input.maxRetries ?? DEFAULT_WORKFLOW_STATE_MAX_RETRIES + 2;
  const now = input.now ?? (() => new Date().toISOString());
  const effectIdentity = buildPlanningOnlyTerminalEffectIdentity(
    input.freeze.policyIdentity,
  );
  let attempt = 0;
  let expectedRevision = input.expectedStateRevision;

  while (attempt < maxRetries) {
    attempt += 1;
    const latest = await input.store.load(input.issueKey);
    if (!latest) {
      throw new DurableStateUnavailableError();
    }
    if (latest.stateRevision !== expectedRevision) {
      if (
        latest.executionPolicyResult?.kind === "terminalized" &&
        latest.executionPolicyResult.policyIdentity ===
          input.freeze.policyIdentity
      ) {
        return latest;
      }
      const decision = decideConflictRetry({
        attempt,
        maxRetries,
        casFailed: true,
      });
      if (!decision.retry) {
        throw new DurableStateCasExhaustedError();
      }
      expectedRevision = latest.stateRevision;
      continue;
    }

    const terminalizedAt = now();
    const terminalized: ExecutionPolicyResult = {
      kind: "terminalized",
      policyIdentity: input.freeze.policyIdentity,
      terminalStatusId: input.freeze.terminalStatusId,
      terminalizedAt,
      planningPhaseExecutionId:
        latest.executionPolicyResult?.planningPhaseExecutionId,
      planGenerationId: latest.executionPolicyResult?.planGenerationId,
    };
    let next = markSideEffectCompleted(latest, effectIdentity, terminalizedAt);
    next = {
      ...next,
      stateRevision: latest.stateRevision + 1,
      executionPolicyResult: terminalized,
      planningOnlyDownstreamSuppressed: true,
    };

    const saved = await input.store.compareAndSet({
      issueKey: input.issueKey,
      expectedRevision: latest.stateRevision,
      next,
    });
    if (saved) {
      return saved;
    }

    const decision = decideConflictRetry({
      attempt,
      maxRetries,
      casFailed: true,
    });
    if (!decision.retry) {
      throw new DurableStateCasExhaustedError();
    }
    const reloaded = await input.store.load(input.issueKey);
    expectedRevision = reloaded?.stateRevision ?? expectedRevision;
  }

  throw new DurableStateCasExhaustedError();
}

export async function reconcilePlanningOnlyTerminalTransition(input: {
  store: WorkflowStateStore;
  issueKey: string;
  freeze: ExecutionPolicyFreeze;
  currentStatusId: string | null | undefined;
  transitionToTerminal: () => Promise<void>;
  maxRetries?: number;
}): Promise<WorkflowStateRecord> {
  if (input.currentStatusId === input.freeze.terminalStatusId) {
    const latest = await input.store.load(input.issueKey);
    if (!latest) {
      throw new DurableStateUnavailableError();
    }
    return completePlanningOnlyTerminalization({
      store: input.store,
      issueKey: input.issueKey,
      freeze: input.freeze,
      expectedStateRevision: latest.stateRevision,
      maxRetries: input.maxRetries,
    });
  }

  await input.transitionToTerminal();
  const latest = await input.store.load(input.issueKey);
  if (!latest) {
    throw new DurableStateUnavailableError();
  }
  return completePlanningOnlyTerminalization({
    store: input.store,
    issueKey: input.issueKey,
    freeze: input.freeze,
    expectedStateRevision: latest.stateRevision,
    maxRetries: input.maxRetries,
  });
}
