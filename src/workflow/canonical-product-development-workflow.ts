/**
 * Canonical product-development workflow descriptor.
 *
 * Product semantics only — no source filenames or function references.
 * Audit traceability lives in tests, architecture docs, and PR evidence.
 */

export type LinearWorkflowStateCategory =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled"
  | "duplicate";

export type CanonicalStatusRole =
  | "dispatch-trigger"
  | "transitional"
  | "human-gate"
  | "terminal"
  | "system-managed";

export type CanonicalActorRole =
  | "planner-agent"
  | "implementation-agent"
  | "revision-agent"
  | "merge-runner"
  | "handoff-runner"
  | "production-sync-runner"
  | "human-gate"
  | "none";

export type CanonicalAgentPhaseKey =
  | "planning"
  | "plan-review"
  | "implementation"
  | "code-review"
  | "code-revision"
  | "revision"
  | "merge-integration-repair";

export type CanonicalStatusKey =
  | "backlog"
  | "ready-for-planning"
  | "planning"
  | "plan-review"
  | "ready-for-build"
  | "building"
  | "pr-open"
  | "code-review"
  | "code-revision"
  | "pm-review"
  | "engineering-review"
  | "needs-revision"
  | "revising"
  | "ready-to-merge"
  | "merging"
  | "merged-to-dev"
  | "merged-deployed"
  | "blocked"
  | "canceled"
  | "duplicate";

export type CanonicalTransitionKind =
  | "success"
  | "failure"
  | "human"
  | "system"
  | "recovery";

export interface CanonicalGraphPosition {
  x: number;
  y: number;
}

export interface CanonicalStatusDefinition {
  key: CanonicalStatusKey;
  name: string;
  category: LinearWorkflowStateCategory;
  role: CanonicalStatusRole;
  creatable: boolean;
  systemManaged: boolean;
  automationTrigger: boolean;
  actorRole: CanonicalActorRole;
  agentPhaseKey?: CanonicalAgentPhaseKey;
  inProgressStatusKey?: CanonicalStatusKey;
  suggestedPosition: CanonicalGraphPosition;
  graphGroup: "intake" | "planning" | "build" | "review" | "merge" | "terminal";
  /** Optional phase statuses are not required in Linear preflight when absent. */
  optionalPhase?: boolean;
}

export interface CanonicalTransition {
  from: CanonicalStatusKey;
  to: CanonicalStatusKey;
  label: string;
  kind: CanonicalTransitionKind;
}

export interface CanonicalAgentPhaseDefinition {
  key: CanonicalAgentPhaseKey;
  label: string;
  sourceStatusKey: CanonicalStatusKey;
  inProgressStatusKey: CanonicalStatusKey;
  successDestinationKey: CanonicalStatusKey;
  failureDestinationKey: CanonicalStatusKey;
  actorRole: CanonicalActorRole;
  supportsModelConfiguration: boolean;
}

export interface CanonicalHumanGateDefinition {
  statusKey: CanonicalStatusKey;
  label: string;
  allowedDestinations: CanonicalStatusKey[];
}

export type MergePathVariant = "integration-then-production" | "direct-production";

export interface CanonicalMergePathDefinition {
  variant: MergePathVariant;
  transitions: CanonicalTransition[];
}

/**
 * Linear provides Duplicate as a built-in system status for superseded issues.
 * It is not creatable via setup and may be absent on some teams.
 * Absence must NOT block harness runs.
 */
export const DUPLICATE_STATUS_CONTRACT = {
  linearGuarantee: "optional-system-terminal" as const,
  requiredForPreflight: false,
  creatable: false,
  systemManaged: true,
  validateWhenPresent: true,
};

export const DEPRECATED_CANONICAL_STATUS_NAMES = [] as const;

/** Human-owned Linear entry statuses that may create bridge job requests. */
export const CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES = [
  "Ready for Planning",
  "Ready for Build",
  "Needs Revision",
  "Ready to Merge",
] as const;

export const CANONICAL_STATUSES: readonly CanonicalStatusDefinition[] = [
  {
    key: "backlog",
    name: "Backlog",
    category: "backlog",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "human-gate",
    suggestedPosition: { x: 0, y: 0 },
    graphGroup: "intake",
  },
  {
    key: "ready-for-planning",
    name: "Ready for Planning",
    category: "unstarted",
    role: "dispatch-trigger",
    creatable: true,
    systemManaged: false,
    automationTrigger: true,
    actorRole: "planner-agent",
    agentPhaseKey: "planning",
    inProgressStatusKey: "planning",
    suggestedPosition: { x: 280, y: 0 },
    graphGroup: "planning",
  },
  {
    key: "planning",
    name: "Planning",
    category: "started",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "planner-agent",
    agentPhaseKey: "planning",
    suggestedPosition: { x: 560, y: 0 },
    graphGroup: "planning",
  },
  {
    key: "plan-review",
    name: "Plan Review",
    category: "started",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "planner-agent",
    agentPhaseKey: "plan-review",
    suggestedPosition: { x: 700, y: 0 },
    graphGroup: "planning",
    optionalPhase: true,
  },
  {
    key: "ready-for-build",
    name: "Ready for Build",
    category: "unstarted",
    role: "dispatch-trigger",
    creatable: true,
    systemManaged: false,
    automationTrigger: true,
    actorRole: "implementation-agent",
    agentPhaseKey: "implementation",
    inProgressStatusKey: "building",
    suggestedPosition: { x: 840, y: 0 },
    graphGroup: "build",
  },
  {
    key: "building",
    name: "Building",
    category: "started",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "implementation-agent",
    agentPhaseKey: "implementation",
    suggestedPosition: { x: 1120, y: 0 },
    graphGroup: "build",
  },
  {
    key: "pr-open",
    name: "PR Open",
    category: "started",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "handoff-runner",
    suggestedPosition: { x: 1400, y: 0 },
    graphGroup: "build",
  },
  {
    key: "code-review",
    name: "Code Review",
    category: "started",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "implementation-agent",
    agentPhaseKey: "code-review",
    suggestedPosition: { x: 1540, y: 0 },
    graphGroup: "build",
    optionalPhase: true,
  },
  {
    key: "code-revision",
    name: "Code Revision",
    category: "started",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "implementation-agent",
    agentPhaseKey: "code-revision",
    suggestedPosition: { x: 1540, y: 120 },
    graphGroup: "build",
    optionalPhase: true,
  },
  {
    key: "pm-review",
    name: "PM Review",
    category: "started",
    role: "human-gate",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "human-gate",
    suggestedPosition: { x: 1680, y: 0 },
    graphGroup: "review",
  },
  {
    key: "engineering-review",
    name: "Engineering Review",
    category: "started",
    role: "human-gate",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "human-gate",
    suggestedPosition: { x: 1960, y: 0 },
    graphGroup: "review",
  },
  {
    key: "needs-revision",
    name: "Needs Revision",
    category: "unstarted",
    role: "dispatch-trigger",
    creatable: true,
    systemManaged: false,
    automationTrigger: true,
    actorRole: "revision-agent",
    agentPhaseKey: "revision",
    inProgressStatusKey: "revising",
    suggestedPosition: { x: 1680, y: 200 },
    graphGroup: "review",
  },
  {
    key: "revising",
    name: "Revising",
    category: "started",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "revision-agent",
    agentPhaseKey: "revision",
    suggestedPosition: { x: 1400, y: 200 },
    graphGroup: "review",
  },
  {
    key: "ready-to-merge",
    name: "Ready to Merge",
    category: "started",
    role: "dispatch-trigger",
    creatable: true,
    systemManaged: false,
    automationTrigger: true,
    actorRole: "merge-runner",
    inProgressStatusKey: "merging",
    suggestedPosition: { x: 2240, y: 0 },
    graphGroup: "merge",
  },
  {
    key: "merging",
    name: "Merging",
    category: "started",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "merge-runner",
    suggestedPosition: { x: 2520, y: 0 },
    graphGroup: "merge",
  },
  {
    key: "merged-to-dev",
    name: "Merged to Dev",
    category: "completed",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "production-sync-runner",
    suggestedPosition: { x: 2800, y: 0 },
    graphGroup: "merge",
  },
  {
    key: "merged-deployed",
    name: "Merged / Deployed",
    category: "completed",
    role: "transitional",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "none",
    suggestedPosition: { x: 3080, y: 0 },
    graphGroup: "merge",
  },
  {
    key: "blocked",
    name: "Blocked",
    category: "started",
    role: "terminal",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "none",
    suggestedPosition: { x: 1120, y: 400 },
    graphGroup: "terminal",
  },
  {
    key: "canceled",
    name: "Canceled",
    category: "canceled",
    role: "terminal",
    creatable: true,
    systemManaged: false,
    automationTrigger: false,
    actorRole: "none",
    suggestedPosition: { x: 1400, y: 400 },
    graphGroup: "terminal",
  },
  {
    key: "duplicate",
    name: "Duplicate",
    category: "duplicate",
    role: "system-managed",
    creatable: false,
    systemManaged: true,
    automationTrigger: false,
    actorRole: "none",
    suggestedPosition: { x: 1680, y: 400 },
    graphGroup: "terminal",
  },
] as const;

export const CANONICAL_AGENT_PHASES: readonly CanonicalAgentPhaseDefinition[] = [
  {
    key: "planning",
    label: "Planning",
    sourceStatusKey: "ready-for-planning",
    inProgressStatusKey: "planning",
    successDestinationKey: "ready-for-build",
    failureDestinationKey: "blocked",
    actorRole: "planner-agent",
    supportsModelConfiguration: true,
  },
  {
    key: "implementation",
    label: "Implementation",
    sourceStatusKey: "ready-for-build",
    inProgressStatusKey: "building",
    successDestinationKey: "pr-open",
    failureDestinationKey: "blocked",
    actorRole: "implementation-agent",
    supportsModelConfiguration: true,
  },
  {
    key: "revision",
    label: "Revision",
    sourceStatusKey: "needs-revision",
    inProgressStatusKey: "revising",
    successDestinationKey: "pm-review",
    failureDestinationKey: "blocked",
    actorRole: "revision-agent",
    supportsModelConfiguration: true,
  },
  {
    key: "merge-integration-repair",
    label: "Merge integration repair",
    sourceStatusKey: "merging",
    inProgressStatusKey: "merging",
    successDestinationKey: "merging",
    failureDestinationKey: "blocked",
    actorRole: "merge-runner",
    supportsModelConfiguration: true,
  },
] as const;

export const CANONICAL_HUMAN_GATES: readonly CanonicalHumanGateDefinition[] = [
  {
    statusKey: "backlog",
    label: "Backlog triage",
    allowedDestinations: ["ready-for-planning", "ready-for-build"],
  },
  {
    statusKey: "pm-review",
    label: "PM review decision",
    allowedDestinations: ["needs-revision", "engineering-review"],
  },
  {
    statusKey: "engineering-review",
    label: "Engineering review decision",
    allowedDestinations: ["needs-revision", "ready-to-merge"],
  },
] as const;

/** Agent-phase automation transitions (success/failure/recovery). */
export const CANONICAL_AUTOMATION_TRANSITIONS: readonly CanonicalTransition[] = [
  { from: "ready-for-planning", to: "planning", label: "Planning", kind: "system" },
  { from: "planning", to: "ready-for-build", label: "Ready for Build", kind: "success" },
  { from: "planning", to: "blocked", label: "Blocked", kind: "failure" },
  { from: "ready-for-build", to: "building", label: "Building", kind: "system" },
  { from: "building", to: "pr-open", label: "PR Open", kind: "success" },
  { from: "building", to: "blocked", label: "Blocked", kind: "failure" },
  { from: "pr-open", to: "pm-review", label: "PM Review", kind: "success" },
  { from: "pr-open", to: "blocked", label: "Blocked", kind: "failure" },
  { from: "needs-revision", to: "revising", label: "Revising", kind: "system" },
  { from: "revising", to: "pm-review", label: "PM Review", kind: "success" },
  { from: "revising", to: "blocked", label: "Blocked", kind: "failure" },
  { from: "ready-to-merge", to: "merging", label: "Merging", kind: "system" },
  { from: "merging", to: "blocked", label: "Blocked", kind: "failure" },
] as const;

/** Human-gate transitions. */
export const CANONICAL_HUMAN_TRANSITIONS: readonly CanonicalTransition[] = [
  { from: "backlog", to: "ready-for-planning", label: "Ready for Planning", kind: "human" },
  { from: "backlog", to: "ready-for-build", label: "Ready for Build", kind: "human" },
  { from: "pm-review", to: "needs-revision", label: "Needs Revision", kind: "human" },
  { from: "pm-review", to: "engineering-review", label: "Engineering Review", kind: "human" },
  {
    from: "engineering-review",
    to: "needs-revision",
    label: "Needs Revision",
    kind: "human",
  },
  {
    from: "engineering-review",
    to: "ready-to-merge",
    label: "Ready to Merge",
    kind: "human",
  },
] as const;

export const CANONICAL_MERGE_PATHS: readonly CanonicalMergePathDefinition[] = [
  {
    variant: "integration-then-production",
    transitions: [
      { from: "merging", to: "merged-to-dev", label: "Merged to Dev", kind: "success" },
      {
        from: "merged-to-dev",
        to: "merged-deployed",
        label: "Merged / Deployed",
        kind: "system",
      },
    ],
  },
  {
    variant: "direct-production",
    transitions: [
      {
        from: "merging",
        to: "merged-deployed",
        label: "Merged / Deployed",
        kind: "success",
      },
    ],
  },
] as const;

export const CANONICAL_WORKFLOW_FINGERPRINT = "canonical-product-development-v1";

export function lookupCanonicalStatus(
  key: CanonicalStatusKey,
): CanonicalStatusDefinition | undefined {
  return CANONICAL_STATUSES.find((status) => status.key === key);
}

export function lookupCanonicalStatusByExactName(
  name: string,
): CanonicalStatusDefinition | undefined {
  return CANONICAL_STATUSES.find((status) => status.name === name);
}

/** Non-authoritative convenience lookup (webhook/dispatch helpers only). */
export function lookupCanonicalStatusByName(
  name: string,
): CanonicalStatusDefinition | undefined {
  const normalized = name.trim().toLowerCase();
  return CANONICAL_STATUSES.find(
    (status) => status.name.toLowerCase() === normalized,
  );
}

export function lookupCanonicalAgentPhase(
  key: CanonicalAgentPhaseKey,
): CanonicalAgentPhaseDefinition | undefined {
  return CANONICAL_AGENT_PHASES.find((phase) => phase.key === key);
}

export function getCanonicalDispatchTriggerStatusNames(): readonly string[] {
  return CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES;
}

export function isCanonicalDispatchTriggerStatusName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES.some(
    (status) => status.toLowerCase() === normalized,
  );
}

export function getRequiredCanonicalStatusNames(options?: {
  includeOptionalDuplicate?: boolean;
}): string[] {
  return CANONICAL_STATUSES.filter((status) => {
    if (status.key === "duplicate") {
      return options?.includeOptionalDuplicate ?? false;
    }
    return true;
  }).map((status) => status.name);
}

export function getCreatableCanonicalStatuses(): CanonicalStatusDefinition[] {
  return CANONICAL_STATUSES.filter((status) => status.creatable);
}

export function getPreflightRequiredCanonicalStatuses(): CanonicalStatusDefinition[] {
  return CANONICAL_STATUSES.filter((status) => {
    if (status.optionalPhase) {
      return false;
    }
    if (status.key === "duplicate") {
      return DUPLICATE_STATUS_CONTRACT.requiredForPreflight;
    }
    return true;
  });
}

export function resolveMergePathVariant(input: {
  baseBranch: string;
  productionBranch: string;
}): MergePathVariant {
  return input.baseBranch === input.productionBranch
    ? "direct-production"
    : "integration-then-production";
}

export function getEffectiveMergeTransitions(input: {
  baseBranch: string;
  productionBranch: string;
}): CanonicalTransition[] {
  const variant = resolveMergePathVariant(input);
  const path = CANONICAL_MERGE_PATHS.find((entry) => entry.variant === variant);
  return path?.transitions ?? [];
}

export function getEffectiveCanonicalTransitions(input: {
  baseBranch: string;
  productionBranch: string;
}): CanonicalTransition[] {
  return [
    ...CANONICAL_AUTOMATION_TRANSITIONS,
    ...CANONICAL_HUMAN_TRANSITIONS,
    ...getEffectiveMergeTransitions(input),
  ];
}

export function getCanonicalStatusKeysOnGraph(): CanonicalStatusKey[] {
  return CANONICAL_STATUSES.map((status) => status.key);
}

export function getDefaultCanonicalLayout(): Record<
  CanonicalStatusKey,
  CanonicalGraphPosition
> {
  const layout = {} as Record<CanonicalStatusKey, CanonicalGraphPosition>;
  for (const status of CANONICAL_STATUSES) {
    layout[status.key] = { ...status.suggestedPosition };
  }
  return layout;
}
