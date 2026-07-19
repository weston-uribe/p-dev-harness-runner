import type { EvaluationSubjectPhase, EvaluationSubjectType } from "../subjects/types.js";
import {
  registerEvaluator,
  setRegistrationResetHookForTests,
  validateRegistryDag,
} from "./registry.js";
import type { EvaluatorDefinitionInput } from "./registry.js";
import * as telemetry from "./impl/telemetry.js";
import * as execution from "./impl/execution.js";
import * as revision from "./impl/revision.js";
import * as workflow from "./impl/workflow.js";

const AGENT_PHASES: EvaluationSubjectPhase[] = [
  "planning",
  "implementation",
  "handoff",
  "revision",
  "integration_repair",
  "merge",
];

let registered = false;

setRegistrationResetHookForTests(() => {
  registered = false;
});

async function reg(
  partial: Omit<EvaluatorDefinitionInput, "determinism" | "dependencies"> & {
    dependencies?: EvaluatorDefinitionInput["dependencies"];
  },
): Promise<void> {
  await registerEvaluator({
    determinism: "pure",
    dependencies: partial.dependencies ?? [],
    ...partial,
  });
}

export async function ensureEvaluatorsRegistered(): Promise<void> {
  if (registered) {
    validateRegistryDag();
    return;
  }

  const telemTypes: EvaluationSubjectType[] = ["phase_execution", "agent_run"];
  const agentPhases: EvaluationSubjectPhase[] = [
    "planning",
    "implementation",
    "revision",
    "integration_repair",
  ];

  await reg({
    evaluatorId: "telemetry.canonical_correlation_present",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/telemetry.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: AGENT_PHASES,
    rubricId: "telemetry-integrity",
    rubricVersion: "1",
    dimensionId: "canonical_correlation_present",
    requiredEvidence: ["telemetry"],
    optionalEvidence: [],
    evaluate: telemetry.evaluateCanonicalCorrelationPresent,
  });
  await reg({
    evaluatorId: "telemetry.event_ids_unique",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/telemetry.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: AGENT_PHASES,
    rubricId: "telemetry-integrity",
    rubricVersion: "1",
    dimensionId: "event_ids_unique",
    requiredEvidence: ["telemetry"],
    optionalEvidence: [],
    evaluate: telemetry.evaluateEventIdsUnique,
  });
  await reg({
    evaluatorId: "telemetry.event_order_valid",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/telemetry.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: AGENT_PHASES,
    rubricId: "telemetry-integrity",
    rubricVersion: "1",
    dimensionId: "event_order_valid",
    requiredEvidence: ["telemetry"],
    optionalEvidence: [],
    evaluate: telemetry.evaluateEventOrderValid,
  });
  await reg({
    evaluatorId: "telemetry.agent_start_finish_paired",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/telemetry.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: agentPhases,
    rubricId: "telemetry-integrity",
    rubricVersion: "1",
    dimensionId: "agent_start_finish_paired",
    requiredEvidence: ["telemetry"],
    optionalEvidence: [],
    evaluate: telemetry.evaluateAgentStartFinishPaired,
  });
  await reg({
    evaluatorId: "telemetry.tool_events_correlated",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/telemetry.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: agentPhases,
    rubricId: "telemetry-integrity",
    rubricVersion: "1",
    dimensionId: "tool_events_correlated",
    requiredEvidence: ["telemetry"],
    optionalEvidence: [],
    evaluate: telemetry.evaluateToolEventsCorrelated,
  });
  await reg({
    evaluatorId: "telemetry.telemetry_completeness_artifact_present",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/telemetry.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: AGENT_PHASES,
    rubricId: "telemetry-integrity",
    rubricVersion: "1",
    dimensionId: "telemetry_completeness_artifact_present",
    requiredEvidence: ["telemetry_completeness"],
    optionalEvidence: ["telemetry"],
    optionalEvidenceAffectsBehavior: ["telemetry"],
    evaluate: telemetry.evaluateTelemetryCompletenessArtifactPresent,
  });
  await reg({
    evaluatorId: "telemetry.artifact_references_resolve",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/telemetry.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: AGENT_PHASES,
    rubricId: "telemetry-integrity",
    rubricVersion: "1",
    dimensionId: "artifact_references_resolve",
    requiredEvidence: ["telemetry"],
    optionalEvidence: ["prompt", "agent_output", "cursor_run_result", "pm_feedback"],
    optionalEvidenceAffectsBehavior: [
      "prompt",
      "agent_output",
      "cursor_run_result",
      "pm_feedback",
    ],
    evaluate: telemetry.evaluateArtifactReferencesResolve,
  });
  await reg({
    evaluatorId: "telemetry.artifact_hashes_match",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/telemetry.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: AGENT_PHASES,
    rubricId: "telemetry-integrity",
    rubricVersion: "1",
    dimensionId: "artifact_hashes_match",
    requiredEvidence: ["telemetry"],
    optionalEvidence: ["prompt", "agent_output", "cursor_run_result", "pm_feedback"],
    optionalEvidenceAffectsBehavior: [
      "prompt",
      "agent_output",
      "cursor_run_result",
      "pm_feedback",
    ],
    evaluate: telemetry.evaluateArtifactHashesMatch,
  });

  // Execution contract
  await reg({
    evaluatorId: "execution.phase_completed_successfully",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: AGENT_PHASES,
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "phase_completed_successfully",
    requiredEvidence: ["manifest"],
    optionalEvidence: [],
    evaluate: execution.evaluatePhaseCompletedSuccessfully,
  });
  await reg({
    evaluatorId: "execution.expected_agent_run_present",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: agentPhases,
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "expected_agent_run_present",
    requiredEvidence: ["manifest"],
    optionalEvidence: ["cursor_run_result"],
    evaluate: execution.evaluateExpectedAgentRunPresent,
  });
  await reg({
    evaluatorId: "execution.prompt_artifact_present",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: agentPhases,
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "prompt_artifact_present",
    requiredEvidence: ["prompt"],
    optionalEvidence: [],
    evaluate: execution.evaluatePromptArtifactPresent,
  });
  await reg({
    evaluatorId: "execution.output_artifact_present",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: ["planning", "implementation", "revision"],
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "output_artifact_present",
    requiredEvidence: ["agent_output"],
    optionalEvidence: [],
    evaluate: execution.evaluateOutputArtifactPresent,
  });
  await reg({
    evaluatorId: "execution.model_identity_present",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: agentPhases,
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "model_identity_present",
    requiredEvidence: ["manifest"],
    optionalEvidence: ["cursor_run_result", "telemetry"],
    optionalEvidenceAffectsBehavior: ["cursor_run_result", "telemetry"],
    evaluate: execution.evaluateModelIdentityPresent,
  });
  await reg({
    evaluatorId: "execution.usage_evidence_present",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: agentPhases,
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "usage_evidence_present",
    requiredEvidence: ["manifest"],
    optionalEvidence: ["cursor_run_result", "telemetry"],
    optionalEvidenceAffectsBehavior: ["cursor_run_result", "telemetry"],
    evaluate: execution.evaluateUsageEvidencePresent,
  });
  await reg({
    evaluatorId: "execution.pr_created_when_required",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: ["phase_execution"],
    applicablePhases: ["implementation", "revision"],
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "pr_created_when_required",
    requiredEvidence: ["manifest"],
    optionalEvidence: ["pr_metadata"],
    evaluate: execution.evaluatePrCreatedWhenRequired,
  });
  await reg({
    evaluatorId: "execution.target_repository_consistent",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: ["phase_execution"],
    applicablePhases: ["implementation", "revision"],
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "target_repository_consistent",
    requiredEvidence: ["manifest"],
    optionalEvidence: ["pr_metadata"],
    optionalEvidenceAffectsBehavior: ["pr_metadata"],
    evaluate: execution.evaluateTargetRepositoryConsistent,
  });
  await reg({
    evaluatorId: "execution.base_branch_consistent",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: ["phase_execution"],
    applicablePhases: ["implementation", "revision"],
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "base_branch_consistent",
    requiredEvidence: ["manifest"],
    optionalEvidence: ["pr_metadata"],
    optionalEvidenceAffectsBehavior: ["pr_metadata"],
    evaluate: execution.evaluateBaseBranchConsistent,
  });
  await reg({
    evaluatorId: "execution.validation_commands_observed",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: ["implementation", "revision", "integration_repair"],
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "validation_commands_observed",
    requiredEvidence: ["telemetry"],
    optionalEvidence: ["prompt", "manifest"],
    optionalEvidenceAffectsBehavior: ["prompt", "manifest"],
    evaluate: execution.evaluateValidationCommandsObserved,
  });
  await reg({
    evaluatorId: "execution.validation_commands_succeeded",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: telemTypes,
    applicablePhases: ["implementation", "revision", "integration_repair"],
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "validation_commands_succeeded",
    requiredEvidence: ["telemetry"],
    optionalEvidence: ["prompt", "manifest"],
    optionalEvidenceAffectsBehavior: ["prompt", "manifest"],
    dependencies: [
      {
        evaluatorId: "execution.validation_commands_observed",
        acceptableVersions: ["1"],
      },
    ],
    evaluate: execution.evaluateValidationCommandsSucceeded,
  });
  await reg({
    evaluatorId: "execution.final_report_identifiers_consistent",
    evaluatorVersion: "1",
    implementationVersion: "1",
    sourceModule: "impl/execution.ts",
    applicableSubjectTypes: ["phase_execution"],
    applicablePhases: [
      "planning",
      "implementation",
      "revision",
      "handoff",
      "merge",
    ],
    rubricId: "execution-contract",
    rubricVersion: "1",
    dimensionId: "final_report_identifiers_consistent",
    requiredEvidence: ["agent_output", "manifest"],
    optionalEvidence: [],
    evaluate: execution.evaluateFinalReportIdentifiersConsistent,
  });

  // Revision
  const rev = async (
    id: string,
    dimensionId: string,
    required: string[],
    optional: string[],
    fn: EvaluatorDefinitionInput["evaluate"],
    deps: EvaluatorDefinitionInput["dependencies"] = [],
  ) => {
    await reg({
      evaluatorId: id,
      evaluatorVersion: "1",
      implementationVersion: "1",
      sourceModule: "impl/revision.ts",
      applicableSubjectTypes: ["revision_cycle"],
      applicablePhases: ["revision"],
      rubricId: "revision-contract",
      rubricVersion: "1",
      dimensionId,
      requiredEvidence: required,
      optionalEvidence: optional,
      optionalEvidenceAffectsBehavior: optional,
      dependencies: deps,
      evaluate: fn,
    });
  };

  await rev(
    "revision.feedback_identity_present",
    "feedback_identity_present",
    ["manifest"],
    [],
    revision.evaluateFeedbackIdentityPresent,
  );
  await rev(
    "revision.feedback_artifact_present",
    "feedback_artifact_present",
    ["pm_feedback"],
    [],
    revision.evaluateFeedbackArtifactPresent,
  );
  await rev(
    "revision.revision_processed_once",
    "revision_processed_once",
    ["manifest", "session_subjects"],
    [],
    revision.evaluateRevisionProcessedOnce,
  );
  await rev(
    "revision.builder_continuity_preserved",
    "builder_continuity_preserved",
    ["manifest"],
    ["session_subjects"],
    revision.evaluateBuilderContinuityPreserved,
  );
  await rev(
    "revision.same_pr_preserved",
    "same_pr_preserved",
    ["manifest"],
    ["pr_metadata"],
    revision.evaluateSamePrPreserved,
  );
  await rev(
    "revision.post_revision_validation_observed",
    "post_revision_validation_observed",
    ["telemetry"],
    ["manifest", "prompt"],
    revision.evaluatePostRevisionValidationObserved,
  );
  await rev(
    "revision.revision_output_present",
    "revision_output_present",
    ["agent_output"],
    [],
    revision.evaluateRevisionOutputPresent,
  );

  // Workflow
  const wf = async (
    id: string,
    dimensionId: string,
    fn: EvaluatorDefinitionInput["evaluate"],
  ) => {
    await reg({
      evaluatorId: id,
      evaluatorVersion: "1",
      implementationVersion: "1",
      sourceModule: "impl/workflow.ts",
      applicableSubjectTypes: ["workflow_session"],
      applicablePhases: null,
      rubricId: "workflow-integrity",
      rubricVersion: "1",
      dimensionId,
      requiredEvidence: ["session_subjects", "manifests"],
      optionalEvidence: ["deployment"],
      optionalEvidenceAffectsBehavior: ["deployment"],
      evaluate: fn,
    });
  };

  await wf(
    "workflow.phase_sequence_valid",
    "phase_sequence_valid",
    workflow.evaluatePhaseSequenceValid,
  );
  await wf(
    "workflow.phase_links_consistent",
    "phase_links_consistent",
    workflow.evaluatePhaseLinksConsistent,
  );
  await wf(
    "workflow.duplicate_execution_prevented",
    "duplicate_execution_prevented",
    workflow.evaluateDuplicateExecutionPrevented,
  );
  await wf(
    "workflow.review_outcome_consistent",
    "review_outcome_consistent",
    workflow.evaluateReviewOutcomeConsistent,
  );
  await wf(
    "workflow.merge_outcome_consistent",
    "merge_outcome_consistent",
    workflow.evaluateMergeOutcomeConsistent,
  );
  await wf(
    "workflow.delivery_outcome_consistent",
    "delivery_outcome_consistent",
    workflow.evaluateDeliveryOutcomeConsistent,
  );
  await wf(
    "workflow.terminal_state_consistent",
    "terminal_state_consistent",
    workflow.evaluateTerminalStateConsistent,
  );

  validateRegistryDag();
  registered = true;
}
