/**
 * Shared helper: evaluate transitions via the workflow engine.
 * Phase files must not invent status routing independently.
 */

import type { HarnessConfig } from "../config/types.js";
import { migrateWorkflowConfigSection } from "../config/migrate-workflow-config.js";
import { getRegistryEntryByName } from "../prompts/registry.js";
import { resolveWorkflowDefinition } from "../workflow/definition/resolve.js";
import type { ResolvedWorkflowDefinition } from "../workflow/definition/types.js";
import {
  evaluateTransition,
  type PhaseOutcome,
  type TransitionEvidence,
  type TransitionResult,
} from "../workflow/transition-engine.js";
import {
  applyWorkflowTransition,
  type PhaseExecutionFreeze,
  type WorkflowStateStore,
} from "../workflow/state/index.js";
import type { PhaseBypassEvent } from "../workflow/optional-phase.js";
import type { PlanArtifactIdentity } from "../workflow/plan-artifact.js";
import type { ImplementationArtifactIdentity } from "../workflow/implementation-artifact.js";
import {
  evaluateCodeReviewReadinessSync,
  type LinearStatusSnapshot,
} from "../workflow/code-review-readiness.js";

function syncCodeReviewConfiguredReady(input: {
  config: HarnessConfig;
  linearStatuses?: readonly LinearStatusSnapshot[] | null;
}): boolean {
  const codeReviewPrompt =
    getRegistryEntryByName("p-dev.code-review")?.definition.implemented === true;
  const codeRevisionPrompt =
    getRegistryEntryByName("p-dev.code-revision")?.definition.implemented ===
    true;
  return evaluateCodeReviewReadinessSync({
    config: input.config,
    linearStatuses: input.linearStatuses ?? null,
    promptImplemented: codeReviewPrompt,
    revisionPromptImplemented: codeRevisionPrompt,
    skillPresent: true,
    modelConfigValid: true,
    reviserModelConfigValid: true,
  }).configuredReady;
}

export function resolveDefinitionForConfig(input: {
  config: HarnessConfig;
  baseBranch?: string;
  productionBranch?: string;
  /** Fail-closed effective Plan Review activation for routing. */
  planReviewEffectiveEnabled?: boolean;
  /** Fail-closed effective Code Review activation for routing (configuredReady). */
  codeReviewEffectiveEnabled?: boolean;
  /** When omitted, Code Review readiness treats statuses as missing (fail-closed). */
  linearStatuses?: readonly LinearStatusSnapshot[] | null;
}): ResolvedWorkflowDefinition {
  const workflowConfig = migrateWorkflowConfigSection(input.config);
  const shouldApplyEffective =
    input.planReviewEffectiveEnabled !== undefined ||
    input.codeReviewEffectiveEnabled !== undefined ||
    input.linearStatuses !== undefined;

  return resolveWorkflowDefinition({
    workflowConfig,
    baseBranch: input.baseBranch,
    productionBranch: input.productionBranch,
    ...(shouldApplyEffective
      ? {
          effectiveOptionalPhases: {
            planReview:
              input.planReviewEffectiveEnabled ??
              workflowConfig.optionalPhases.planReview === true,
            codeReview:
              input.codeReviewEffectiveEnabled ??
              syncCodeReviewConfiguredReady({
                config: input.config,
                linearStatuses: input.linearStatuses ?? null,
              }),
          },
        }
      : {}),
  });
}

export function evaluatePhaseTransition(input: {
  config: HarnessConfig;
  currentPhaseId: string;
  outcome: PhaseOutcome;
  evidence: TransitionEvidence;
  cycleCounters?: Record<string, number>;
  baseBranch?: string;
  productionBranch?: string;
  planReviewEffectiveEnabled?: boolean;
  codeReviewEffectiveEnabled?: boolean;
  linearStatuses?: readonly LinearStatusSnapshot[] | null;
}): TransitionResult {
  const definition = resolveDefinitionForConfig(input);
  return evaluateTransition({
    definition,
    currentPhaseId: input.currentPhaseId,
    outcome: input.outcome,
    cycleCounters: input.cycleCounters ?? {
      plan_review_cycles: 0,
      code_review_cycles: 0,
    },
    evidence: input.evidence,
  });
}

/**
 * Resolve the Linear status name for a phase outcome using the transition engine.
 * Throws when the transition is rejected.
 */
export function resolveNextStatusName(input: {
  config: HarnessConfig;
  currentPhaseId: string;
  outcome: PhaseOutcome;
  evidence: TransitionEvidence;
  baseBranch?: string;
  productionBranch?: string;
  planReviewEffectiveEnabled?: boolean;
  codeReviewEffectiveEnabled?: boolean;
  linearStatuses?: readonly LinearStatusSnapshot[] | null;
}): {
  statusName: string;
  result: TransitionResult;
  bypass: PhaseBypassEvent | null;
} {
  const result = evaluatePhaseTransition(input);
  if (!result.accepted || !result.nextStatusName) {
    throw new Error(
      `Workflow transition rejected: ${result.rejectReason ?? result.reason}`,
    );
  }
  return {
    statusName: result.nextStatusName,
    result,
    bypass: result.bypass,
  };
}

export async function applyPhaseTransition(input: {
  store: WorkflowStateStore;
  issueKey: string;
  config: HarnessConfig;
  expectedStateRevision: number;
  currentPhaseId: string;
  outcome: PhaseOutcome;
  evidence: TransitionEvidence;
  baseBranch?: string;
  productionBranch?: string;
  claimActiveRunId?: string;
  clearActiveRunId?: string;
  clearActiveRunLease?: {
    expectedIdentity: string;
    expectedOwnerRunId: string;
  };
  phaseExecutionId?: string;
  planReviewEffectiveEnabled?: boolean;
  codeReviewEffectiveEnabled?: boolean;
  linearStatuses?: readonly LinearStatusSnapshot[] | null;
  returnDestination?: string | null;
  latestPlanArtifact?: PlanArtifactIdentity | null;
  latestImplementationArtifact?: ImplementationArtifactIdentity | null;
  phaseExecutionFreeze?: PhaseExecutionFreeze | null;
}): Promise<{
  statusName: string | null;
  applyOk: boolean;
  result: TransitionResult | null;
  reason: string;
  stateRevision: number | null;
  state: Awaited<
    ReturnType<typeof applyWorkflowTransition>
  >["state"];
}> {
  const definition = resolveDefinitionForConfig(input);
  const applied = await applyWorkflowTransition({
    store: input.store,
    issueKey: input.issueKey,
    definition,
    expectedStateRevision: input.expectedStateRevision,
    currentPhaseId: input.currentPhaseId,
    outcome: input.outcome,
    evidence: input.evidence,
    claimActiveRunId: input.claimActiveRunId,
    clearActiveRunId: input.clearActiveRunId,
    clearActiveRunLease: input.clearActiveRunLease,
    phaseExecutionId: input.phaseExecutionId,
    returnDestination: input.returnDestination,
    latestPlanArtifact: input.latestPlanArtifact,
    latestImplementationArtifact: input.latestImplementationArtifact,
    phaseExecutionFreeze: input.phaseExecutionFreeze,
  });
  return {
    statusName: applied.transition?.nextStatusName ?? null,
    applyOk: applied.ok,
    result: applied.transition,
    reason: applied.reason,
    stateRevision: applied.state?.stateRevision ?? null,
    state: applied.state,
  };
}
