import type { WorkflowDefinition } from "./types.js";
import {
  assertDistinctStatusPhaseRoles,
  PRODUCT_DEVELOPMENT_ROLE_MAPPINGS,
  WORKFLOW_AGENT_ROLES,
  WORKFLOW_MODEL_ROLES,
  WORKFLOW_PROMPT_ROLES,
  WORKFLOW_SKILL_ROLES,
} from "./roles.js";

export interface WorkflowDefinitionValidationResult {
  ok: boolean;
  errors: string[];
}

const KNOWN_ENABLED_BY = new Set([
  "optionalPhases.planReview",
  "optionalPhases.codeReview",
]);

export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
): WorkflowDefinitionValidationResult {
  const errors: string[] = [];
  const phaseIds = new Set(definition.phases.map((p) => p.id));
  const statusIds = new Set(definition.statuses.map((s) => s.id));
  const counterIds = new Set(definition.loopCounters.map((c) => c.id));

  if (!definition.schemaVersion.trim()) {
    errors.push("schemaVersion is required");
  }

  const seenPhaseIds = new Set<string>();
  for (const phase of definition.phases) {
    if (seenPhaseIds.has(phase.id)) {
      errors.push(`duplicate phase id: ${phase.id}`);
    }
    seenPhaseIds.add(phase.id);
    if (!statusIds.has(phase.status)) {
      errors.push(`phase ${phase.id} references unknown status ${phase.status}`);
    }
    if (phase.optional && !phase.enabledBy) {
      errors.push(`optional phase ${phase.id} requires enabledBy`);
    }
    if (phase.enabledBy && !KNOWN_ENABLED_BY.has(phase.enabledBy)) {
      errors.push(
        `phase ${phase.id} has unknown enabledBy key: ${phase.enabledBy}`,
      );
    }
    if (phase.optional && !phase.bypassNext) {
      errors.push(`optional phase ${phase.id} requires bypassNext`);
    }
    if (phase.bypassNext && !phaseIds.has(phase.bypassNext)) {
      errors.push(
        `phase ${phase.id} bypassNext references unknown phase ${phase.bypassNext}`,
      );
    }
    if (phase.defaultNext && !phaseIds.has(phase.defaultNext)) {
      errors.push(
        `phase ${phase.id} defaultNext references unknown phase ${phase.defaultNext}`,
      );
    }
    if (phase.failureNext && !phaseIds.has(phase.failureNext)) {
      errors.push(
        `phase ${phase.id} failureNext references unknown phase ${phase.failureNext}`,
      );
    }
    if (phase.retryTarget && !phaseIds.has(phase.retryTarget)) {
      errors.push(
        `phase ${phase.id} retryTarget references unknown phase ${phase.retryTarget}`,
      );
    }
    if (phase.cycleCounter && !counterIds.has(phase.cycleCounter)) {
      errors.push(
        `phase ${phase.id} cycleCounter references unknown counter ${phase.cycleCounter}`,
      );
    }
    if (phase.agentRole && !WORKFLOW_AGENT_ROLES.includes(phase.agentRole as never)) {
      errors.push(`phase ${phase.id} has unknown agentRole ${phase.agentRole}`);
    }
    if (
      phase.promptRole &&
      !WORKFLOW_PROMPT_ROLES.includes(phase.promptRole as never)
    ) {
      errors.push(`phase ${phase.id} has unknown promptRole ${phase.promptRole}`);
    }
    if (
      phase.skillRole &&
      !WORKFLOW_SKILL_ROLES.includes(phase.skillRole as never)
    ) {
      errors.push(`phase ${phase.id} has unknown skillRole ${phase.skillRole}`);
    }
    if (
      phase.modelRole &&
      !WORKFLOW_MODEL_ROLES.includes(phase.modelRole as never)
    ) {
      errors.push(`phase ${phase.id} has unknown modelRole ${phase.modelRole}`);
    }
    for (const decision of phase.decisions ?? []) {
      if (!phaseIds.has(decision.nextPhaseId)) {
        errors.push(
          `phase ${phase.id} decision ${decision.id} references unknown nextPhaseId ${decision.nextPhaseId}`,
        );
      }
    }
  }

  for (const transition of definition.transitions) {
    if (!phaseIds.has(transition.fromPhaseId)) {
      errors.push(
        `transition ${transition.id} from unknown phase ${transition.fromPhaseId}`,
      );
    }
    if (!phaseIds.has(transition.toPhaseId)) {
      errors.push(
        `transition ${transition.id} to unknown phase ${transition.toPhaseId}`,
      );
    }
  }

  for (const terminalId of definition.terminalPhaseIds) {
    if (!phaseIds.has(terminalId)) {
      errors.push(`terminalPhaseIds references unknown phase ${terminalId}`);
    }
  }

  for (const statusId of definition.dispatchTriggerStatusIds) {
    if (!statusIds.has(statusId)) {
      errors.push(
        `dispatchTriggerStatusIds references unknown status ${statusId}`,
      );
    }
  }

  const seenCounters = new Set<string>();
  for (const counter of definition.loopCounters) {
    if (seenCounters.has(counter.id)) {
      errors.push(`duplicate loop counter id: ${counter.id}`);
    }
    seenCounters.add(counter.id);
  }

  for (const mapping of PRODUCT_DEVELOPMENT_ROLE_MAPPINGS) {
    errors.push(...assertDistinctStatusPhaseRoles(mapping));
  }

  // Building must not share identity with implementation or builder.
  const building = PRODUCT_DEVELOPMENT_ROLE_MAPPINGS.find(
    (m) => m.statusId === "building",
  );
  if (building) {
    if (building.phaseId !== "implementation") {
      errors.push("building status must map to implementation phase");
    }
    if (building.agentRole !== "builder") {
      errors.push("building status must use agentRole builder");
    }
    if (building.promptRole !== "implementer") {
      errors.push("building status must use promptRole implementer");
    }
    if (building.modelRole !== "builder") {
      errors.push("building status must use modelRole builder");
    }
  }

  return { ok: errors.length === 0, errors };
}
