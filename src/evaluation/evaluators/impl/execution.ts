import type { EvaluationContext, EvaluatorOutcome } from "../types.js";
import {
  AGENT_EXPECTED_PHASES,
  PR_REQUIRED_PHASES,
  evidenceOrSkip,
  fail,
  notApplicable,
  pass,
  requireEvidence,
} from "./shared.js";
import {
  evaluateValidationObserved,
  evaluateValidationSucceeded,
  expectedValidationCommandsFromEvidence,
  normalizeShellToolCalls,
} from "./validation-match.js";

export async function evaluatePhaseCompletedSuccessfully(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const skip = requireEvidence(ctx, ["manifest"]);
  if (skip) return skip;
  if (!ctx.manifest) {
    return fail("manifest_unreadable", "Manifest could not be loaded.");
  }
  if (ctx.manifest.finalOutcome === "success") {
    return pass(
      "phase_completed_successfully",
      "Manifest finalOutcome is success.",
    );
  }
  if (
    ctx.manifest.finalOutcome === "skipped" ||
    ctx.manifest.finalOutcome === "duplicate"
  ) {
    return notApplicable(
      "phase_not_success_terminal",
      `Phase ended as ${ctx.manifest.finalOutcome}; success check not applicable.`,
    );
  }
  return fail(
    "phase_not_successful",
    `Manifest finalOutcome is ${ctx.manifest.finalOutcome}.`,
  );
}

export async function evaluateExpectedAgentRunPresent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const phase = ctx.subject.phase;
  if (phase == null || !AGENT_EXPECTED_PHASES.has(phase)) {
    return notApplicable(
      "agent_run_not_required",
      "Agent run not required for this phase.",
    );
  }
  const skip = requireEvidence(ctx, ["manifest"]);
  if (skip) return skip;
  const agentId = ctx.manifest?.cursorAgentId ?? ctx.subject.agentId;
  const runId = ctx.manifest?.cursorRunId ?? ctx.subject.agentRunId;
  if (!agentId || !runId) {
    return fail(
      "expected_agent_run_missing",
      "Expected agent run identity is missing from manifest/subject.",
    );
  }
  return pass(
    "expected_agent_run_present",
    "Expected agent run identity is present.",
  );
}

export async function evaluatePromptArtifactPresent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const phase = ctx.subject.phase;
  if (
    phase == null ||
    !["planning", "implementation", "revision", "integration_repair"].includes(
      phase,
    )
  ) {
    return notApplicable(
      "prompt_not_applicable",
      "Prompt artifact not required for this phase.",
    );
  }
  return presenceCheck(ctx, "prompt", "prompt_artifact_present");
}

export async function evaluateOutputArtifactPresent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const phase = ctx.subject.phase;
  if (
    phase == null ||
    !["planning", "implementation", "revision"].includes(phase)
  ) {
    return notApplicable(
      "output_not_applicable",
      "Output artifact not required for this phase.",
    );
  }
  return presenceCheck(ctx, "agent_output", "output_artifact_present");
}

function presenceCheck(
  ctx: EvaluationContext,
  key: string,
  passCode: string,
): EvaluatorOutcome {
  const resolved = evidenceOrSkip(ctx, key);
  if ("skip" in resolved) {
    if (resolved.skip.reasonCode === "missing_required_evidence") {
      return fail(
        `${key}_absent`,
        `Required ${key} artifact is absent.`,
      );
    }
    return resolved.skip;
  }
  return pass(passCode, `${key} artifact is present and verified.`);
}

export async function evaluateModelIdentityPresent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const phase = ctx.subject.phase;
  if (phase == null || !AGENT_EXPECTED_PHASES.has(phase)) {
    return notApplicable(
      "model_identity_not_applicable",
      "Model identity not applicable for this phase.",
    );
  }
  const skip = requireEvidence(ctx, ["manifest"]);
  if (skip) return skip;
  const manifestModel = ctx.manifest?.model ?? null;
  const subjectModel = ctx.subject.modelId;
  const cursorContent = ctx.evidence.cursor_run_result?.content;
  let cursorModel: string | null = null;
  if (cursorContent) {
    try {
      const parsed = JSON.parse(cursorContent) as { model?: string };
      cursorModel = parsed.model ?? null;
    } catch {
      return fail(
        "cursor_result_unparseable",
        "Cursor run result present but not valid JSON.",
      );
    }
  }
  const models = [manifestModel, subjectModel, cursorModel].filter(
    (m): m is string => typeof m === "string" && m.length > 0,
  );
  if (models.length === 0) {
    return fail("model_identity_missing", "No model identity found.");
  }
  const unique = new Set(models);
  if (unique.size > 1) {
    return fail(
      "model_identity_mismatch",
      `Model identity disagrees across evidence: ${[...unique].join(", ")}`,
    );
  }
  return pass(
    "model_identity_present",
    "Model identity is present and consistent.",
  );
}

export async function evaluateUsageEvidencePresent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const phase = ctx.subject.phase;
  if (phase == null || !AGENT_EXPECTED_PHASES.has(phase)) {
    return notApplicable(
      "usage_not_applicable",
      "Usage evidence not applicable for this phase.",
    );
  }
  const cursorContent = ctx.evidence.cursor_run_result?.content;
  const usageEvents = ctx.telemetryEvents.filter((e) => e.kind === "model_usage");
  if (!cursorContent && usageEvents.length === 0) {
    return notApplicable(
      "usage_evidence_absent_optional",
      "No usage evidence captured for this run.",
    );
  }
  const values: number[] = [];
  if (cursorContent) {
    try {
      const parsed = JSON.parse(cursorContent) as {
        usage?: Record<string, unknown>;
      };
      if (parsed.usage) {
        for (const v of Object.values(parsed.usage)) {
          if (typeof v === "number") values.push(v);
        }
      }
    } catch {
      return fail("usage_unparseable", "Usage payload could not be parsed.");
    }
  }
  for (const event of usageEvents) {
    const usage = event.payload?.usage as Record<string, unknown> | undefined;
    if (usage) {
      for (const v of Object.values(usage)) {
        if (typeof v === "number") values.push(v);
      }
    }
  }
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    return fail(
      "usage_not_finite",
      "Usage values are not finite non-negative numbers.",
    );
  }
  return pass(
    "usage_evidence_present",
    "Usage evidence is finite and internally consistent when present.",
  );
}

export async function evaluatePrCreatedWhenRequired(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  if (ctx.subject.subjectType !== "phase_execution") {
    return notApplicable(
      "pr_check_subject_not_applicable",
      "PR creation check applies to phase_execution only.",
    );
  }
  const phase = ctx.subject.phase;
  if (phase == null || !PR_REQUIRED_PHASES.has(phase)) {
    return notApplicable(
      "pr_not_required_for_phase",
      "PR creation not required for this phase.",
    );
  }
  const skip = requireEvidence(ctx, ["manifest"]);
  if (skip) return skip;
  if (!ctx.manifest?.prUrl) {
    return fail(
      "pr_missing_when_required",
      "PR URL missing when required for this phase.",
    );
  }
  return pass("pr_created_when_required", "PR identity is present.");
}

export async function evaluateTargetRepositoryConsistent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  if (ctx.subject.subjectType !== "phase_execution") {
    return notApplicable(
      "repo_check_not_applicable",
      "Repository consistency applies to phase_execution only.",
    );
  }
  const phase = ctx.subject.phase;
  if (phase == null || !PR_REQUIRED_PHASES.has(phase)) {
    return notApplicable(
      "repo_check_phase_not_applicable",
      "Repository consistency not applicable for this phase.",
    );
  }
  const skip = requireEvidence(ctx, ["manifest"]);
  if (skip) return skip;
  const prContent = ctx.evidence.pr_metadata?.content;
  if (!prContent) {
    return notApplicable(
      "pr_metadata_absent",
      "PR metadata absent; repository consistency not proven.",
    );
  }
  try {
    const pr = JSON.parse(prContent) as { repoUrl?: string };
    if (!pr.repoUrl) {
      return skippedInsufficient("pr_repo_missing", "PR metadata lacks repoUrl.");
    }
    return pass(
      "target_repository_consistent",
      "Repository identity present in PR metadata.",
    );
  } catch {
    return fail("pr_metadata_unparseable", "PR metadata is not valid JSON.");
  }
}

function skippedInsufficient(
  reasonCode: string,
  explanation: string,
): EvaluatorOutcome {
  return {
    status: "skipped",
    result: null,
    skipReason: "insufficient_evidence",
    reasonCode,
    explanation,
  };
}

export async function evaluateBaseBranchConsistent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  if (ctx.subject.subjectType !== "phase_execution") {
    return notApplicable(
      "base_branch_subject_not_applicable",
      "Base branch check applies to phase_execution only.",
    );
  }
  const phase = ctx.subject.phase;
  if (phase == null || !PR_REQUIRED_PHASES.has(phase)) {
    return notApplicable(
      "base_branch_phase_not_applicable",
      "Base branch check not applicable for this phase.",
    );
  }
  const prContent = ctx.evidence.pr_metadata?.content;
  if (!prContent) {
    return skippedInsufficient(
      "pr_metadata_absent",
      "PR metadata absent; base branch consistency not proven.",
    );
  }
  try {
    const pr = JSON.parse(prContent) as { baseBranch?: string };
    if (!pr.baseBranch) {
      return skippedInsufficient(
        "base_branch_missing",
        "PR metadata lacks baseBranch.",
      );
    }
    return pass(
      "base_branch_consistent",
      "Base branch present in PR evidence.",
    );
  } catch {
    return fail("pr_metadata_unparseable", "PR metadata is not valid JSON.");
  }
}

function validationInputs(ctx: EvaluationContext): {
  expected: string[];
  toolCalls: ReturnType<typeof normalizeShellToolCalls>;
} {
  const promptContent = ctx.evidence.prompt?.content ?? null;
  const summary = ctx.manifest?.validationSummary ?? null;
  const { commands } = expectedValidationCommandsFromEvidence({
    promptContent,
    manifestValidationSummary: summary,
  });
  return {
    expected: commands,
    toolCalls: normalizeShellToolCalls(ctx.telemetryEvents),
  };
}

export async function evaluateValidationCommandsObserved(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const phase = ctx.subject.phase;
  if (
    phase == null ||
    !["implementation", "revision", "integration_repair"].includes(phase)
  ) {
    return notApplicable(
      "validation_not_applicable",
      "Validation command checks not applicable for this phase.",
    );
  }
  const tel = ctx.evidence.telemetry;
  if (!tel?.present || tel.untrusted) {
    return skippedInsufficient(
      "validation_telemetry_unavailable",
      "Telemetry unavailable for validation command checks.",
    );
  }
  const { expected, toolCalls } = validationInputs(ctx);
  return evaluateValidationObserved({ expected, toolCalls });
}

export async function evaluateValidationCommandsSucceeded(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const phase = ctx.subject.phase;
  if (
    phase == null ||
    !["implementation", "revision", "integration_repair"].includes(phase)
  ) {
    return notApplicable(
      "validation_success_not_applicable",
      "Validation success checks not applicable for this phase.",
    );
  }
  const tel = ctx.evidence.telemetry;
  if (!tel?.present || tel.untrusted) {
    return skippedInsufficient(
      "validation_telemetry_unavailable",
      "Telemetry unavailable for validation success checks.",
    );
  }
  const { expected, toolCalls } = validationInputs(ctx);
  return evaluateValidationSucceeded({ expected, toolCalls });
}

export async function evaluateFinalReportIdentifiersConsistent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  if (ctx.subject.subjectType !== "phase_execution") {
    return notApplicable(
      "report_id_subject_not_applicable",
      "Final report identifier check applies to phase_execution.",
    );
  }
  const skip = requireEvidence(ctx, ["manifest"]);
  if (skip) return skip;
  const output = ctx.evidence.agent_output;
  if (!output?.present) {
    return notApplicable(
      "report_absent",
      "No agent output report to check identifiers against.",
    );
  }
  if (output.untrusted) {
    return skippedInsufficient(
      "untrusted_evidence",
      "Agent output is untrusted; cannot verify identifiers.",
    );
  }
  const content = output.content ?? "";
  const issueKey = ctx.subject.issueKey;
  const runId = ctx.manifest?.runId;
  if (issueKey && content.includes(issueKey)) {
    return pass(
      "final_report_identifiers_consistent",
      "Report contains expected issue key identifier.",
    );
  }
  if (runId && content.includes(runId)) {
    return pass(
      "final_report_identifiers_consistent",
      "Report contains expected run identifier.",
    );
  }
  // Soft: if report exists but doesn't echo IDs, insufficient to prove inconsistency.
  return skippedInsufficient(
    "report_identifiers_unproven",
    "Could not prove report identifier consistency from available content.",
  );
}
