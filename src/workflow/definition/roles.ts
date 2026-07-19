/**
 * Typed separation of Linear status, workflow phase, and agent/prompt/skill/model roles.
 * These identities must not be collapsed into a single string.
 */

export const WORKFLOW_AGENT_ROLES = [
  "planner",
  "builder",
  "plan_reviewer",
  "code_reviewer",
  "none",
] as const;
export type WorkflowAgentRole = (typeof WORKFLOW_AGENT_ROLES)[number];

export const WORKFLOW_PROMPT_ROLES = [
  "planner",
  "implementer",
  "reviser",
  "integration_repairer",
  "plan_reviewer",
  "code_reviewer",
  "code_reviser",
  "none",
] as const;
export type WorkflowPromptRole = (typeof WORKFLOW_PROMPT_ROLES)[number];

export const WORKFLOW_SKILL_ROLES = [
  "planner",
  "implementation",
  "plan_reviewer",
  "code_reviewer",
  "none",
] as const;
export type WorkflowSkillRole = (typeof WORKFLOW_SKILL_ROLES)[number];

/** Config model roles in use today; reserved roles are schema-ready for later chunks. */
export const WORKFLOW_MODEL_ROLES = [
  "planner",
  "builder",
  "plan_reviewer",
  "code_reviewer",
  "code_reviser",
] as const;
export type WorkflowModelRole = (typeof WORKFLOW_MODEL_ROLES)[number];

export const ACTIVE_MODEL_ROLES = [
  "planner",
  "builder",
  "plan_reviewer",
  "code_reviewer",
  "code_reviser",
] as const;
export type ActiveModelRole = (typeof ACTIVE_MODEL_ROLES)[number];

export const RESERVED_MODEL_ROLES = [] as const;

export interface StatusPhaseRoleMapping {
  statusId: string;
  phaseId: string;
  agentRole: WorkflowAgentRole;
  promptRole: WorkflowPromptRole;
  skillRole: WorkflowSkillRole;
  modelRole: WorkflowModelRole | null;
}

/**
 * Canonical mappings for the product-development workflow.
 * Status, phase, and roles are intentionally distinct (e.g. building ≠ implementation ≠ builder).
 */
export const PRODUCT_DEVELOPMENT_ROLE_MAPPINGS: readonly StatusPhaseRoleMapping[] =
  [
    {
      statusId: "ready-for-planning",
      phaseId: "planning_dispatch",
      agentRole: "planner",
      promptRole: "planner",
      skillRole: "planner",
      modelRole: "planner",
    },
    {
      statusId: "planning",
      phaseId: "planning",
      agentRole: "planner",
      promptRole: "planner",
      skillRole: "planner",
      modelRole: "planner",
    },
    {
      statusId: "plan-review",
      phaseId: "plan_review",
      agentRole: "plan_reviewer",
      promptRole: "plan_reviewer",
      skillRole: "plan_reviewer",
      modelRole: "plan_reviewer",
    },
    {
      statusId: "ready-for-build",
      phaseId: "implementation_dispatch",
      agentRole: "builder",
      promptRole: "implementer",
      skillRole: "implementation",
      modelRole: "builder",
    },
    {
      statusId: "building",
      phaseId: "implementation",
      agentRole: "builder",
      promptRole: "implementer",
      skillRole: "implementation",
      modelRole: "builder",
    },
    {
      statusId: "pr-open",
      phaseId: "handoff",
      agentRole: "none",
      promptRole: "none",
      skillRole: "none",
      modelRole: null,
    },
    {
      statusId: "code-review",
      phaseId: "code_review",
      agentRole: "code_reviewer",
      promptRole: "code_reviewer",
      skillRole: "code_reviewer",
      modelRole: "code_reviewer",
    },
    {
      statusId: "code-revision",
      phaseId: "code_revision",
      agentRole: "builder",
      promptRole: "code_reviser",
      skillRole: "implementation",
      modelRole: "code_reviser",
    },
    {
      statusId: "needs-revision",
      phaseId: "revision_dispatch",
      agentRole: "builder",
      promptRole: "reviser",
      skillRole: "implementation",
      modelRole: "builder",
    },
    {
      statusId: "revising",
      phaseId: "revision",
      agentRole: "builder",
      promptRole: "reviser",
      skillRole: "implementation",
      modelRole: "builder",
    },
    {
      statusId: "pm-review",
      phaseId: "pm_review",
      agentRole: "none",
      promptRole: "none",
      skillRole: "none",
      modelRole: null,
    },
    {
      statusId: "engineering-review",
      phaseId: "engineering_review",
      agentRole: "none",
      promptRole: "none",
      skillRole: "none",
      modelRole: null,
    },
    {
      statusId: "ready-to-merge",
      phaseId: "merge_dispatch",
      agentRole: "none",
      promptRole: "none",
      skillRole: "none",
      modelRole: null,
    },
    {
      statusId: "merging",
      phaseId: "merge",
      agentRole: "none",
      promptRole: "none",
      skillRole: "none",
      modelRole: null,
    },
    {
      statusId: "merging",
      phaseId: "integration_repair",
      agentRole: "builder",
      promptRole: "integration_repairer",
      skillRole: "implementation",
      modelRole: "builder",
    },
    {
      statusId: "merged-to-dev",
      phaseId: "production_sync",
      agentRole: "none",
      promptRole: "none",
      skillRole: "none",
      modelRole: null,
    },
  ] as const;

export function lookupRoleMapping(input: {
  statusId?: string;
  phaseId?: string;
}): StatusPhaseRoleMapping | undefined {
  if (input.phaseId) {
    return PRODUCT_DEVELOPMENT_ROLE_MAPPINGS.find(
      (m) => m.phaseId === input.phaseId,
    );
  }
  if (input.statusId) {
    return PRODUCT_DEVELOPMENT_ROLE_MAPPINGS.find(
      (m) => m.statusId === input.statusId,
    );
  }
  return undefined;
}

export function assertDistinctStatusPhaseRoles(
  mapping: StatusPhaseRoleMapping,
): string[] {
  const errors: string[] = [];
  // Status id must not be treated as interchangeable with agent/prompt/model roles.
  if (mapping.agentRole !== "none" && mapping.statusId === mapping.agentRole) {
    errors.push(
      `statusId "${mapping.statusId}" must not equal agentRole "${mapping.agentRole}"`,
    );
  }
  if (
    mapping.modelRole &&
    mapping.statusId === mapping.modelRole &&
    mapping.phaseId !== mapping.statusId
  ) {
    errors.push(
      `statusId "${mapping.statusId}" must not equal modelRole "${mapping.modelRole}"`,
    );
  }
  // Phase and status may share a slug only when intentionally identical; building ≠ implementation.
  if (
    mapping.statusId === "building" &&
    mapping.phaseId === "building"
  ) {
    errors.push("status building must map to phase implementation, not building");
  }
  if (
    mapping.statusId === "building" &&
    mapping.agentRole !== "builder"
  ) {
    errors.push("status building must use agentRole builder");
  }
  if (
    mapping.phaseId === "implementation" &&
    mapping.promptRole !== "implementer"
  ) {
    errors.push("phase implementation must use promptRole implementer");
  }
  return errors;
}
