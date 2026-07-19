/**
 * Provider-neutral modular workflow definition types.
 * Executable business logic must not be stored as arbitrary config strings.
 */

export type WorkflowOwner = "agent" | "human" | "orchestrator" | "terminal";

export type WorkflowTransitionKind =
  | "success"
  | "failure"
  | "human"
  | "system"
  | "recovery"
  | "bypass"
  | "review_approved"
  | "review_needs_revision"
  | "escalation";

export type WorkflowDecisionId = "approved" | "needs_revision";

export interface WorkflowDecisionDefinition {
  id: WorkflowDecisionId;
  label: string;
  nextPhaseId: string;
  incrementsCycleCounter?: boolean;
}

export interface WorkflowReconciliationEligibility {
  eligible: boolean;
  evidenceKeys: readonly string[];
}

export interface WorkflowPhaseDefinition {
  id: string;
  /** Linear status key this phase is associated with (may equal a status id). */
  status: string;
  owner: WorkflowOwner;
  optional: boolean;
  /** Config path key that enables this optional phase (e.g. optionalPhases.planReview). */
  enabledBy?: string;
  label: string;
  agentRole?: string;
  promptRole?: string;
  skillRole?: string;
  modelRole?: string;
  decisions?: readonly WorkflowDecisionDefinition[];
  defaultNext?: string;
  retryTarget?: string;
  /** Destination when this optional phase is disabled. */
  bypassNext?: string;
  maximumCycles?: number;
  cycleCounter?: string;
  evaluationPhase?: string;
  /** Status entered when work is claimed (in-progress). */
  inProgressStatus?: string;
  failureNext?: string;
  reconciliation?: WorkflowReconciliationEligibility;
  /** When false, status is not required in Linear unless the phase is enabled. */
  requiresLinearStatus?: boolean;
}

export interface WorkflowStatusDefinition {
  id: string;
  name: string;
  category:
    | "backlog"
    | "unstarted"
    | "started"
    | "completed"
    | "canceled"
    | "duplicate";
  owner: WorkflowOwner;
  automationTrigger: boolean;
  creatable: boolean;
  systemManaged: boolean;
  /** Optional status only required when a named optional phase is enabled. */
  optionalPhaseId?: string;
  deprecated?: boolean;
}

export interface WorkflowTransitionDefinition {
  id: string;
  fromPhaseId: string;
  toPhaseId: string;
  kind: WorkflowTransitionKind;
  label: string;
  /** When set, transition only applies if the optional phase enablement matches. */
  whenOptionalEnabled?: boolean;
  decisionId?: WorkflowDecisionId;
}

export interface WorkflowLoopCounterDefinition {
  id: string;
  label: string;
  defaultMaximum: number;
  /** Independent counters for plan_review vs code_review, etc. */
  scope: "issue";
}

export interface WorkflowRoleBinding {
  statusId: string;
  phaseId: string;
  agentRole?: string;
  promptRole?: string;
  skillRole?: string;
  modelRole?: string;
}

export interface WorkflowDefinition {
  schemaVersion: string;
  id: string;
  label: string;
  statuses: readonly WorkflowStatusDefinition[];
  phases: readonly WorkflowPhaseDefinition[];
  transitions: readonly WorkflowTransitionDefinition[];
  loopCounters: readonly WorkflowLoopCounterDefinition[];
  roleBindings: readonly WorkflowRoleBinding[];
  terminalPhaseIds: readonly string[];
  dispatchTriggerStatusIds: readonly string[];
}

export interface ResolvedWorkflowDefinition extends WorkflowDefinition {
  /** Fail-closed effective activation used for routing. */
  enabledOptionalPhases: Readonly<Record<string, boolean>>;
  /** User-requested toggles from config (may be true while effective is false). */
  requestedOptionalPhases: Readonly<Record<string, boolean>>;
  cycleLimits: Readonly<Record<string, number>>;
  mergePathVariant: "integration-then-production" | "direct-production";
}
