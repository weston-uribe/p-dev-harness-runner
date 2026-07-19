import type { EvaluationContext, EvaluatorOutcome } from "../types.js";
import {
  evidenceOrSkip,
  fail,
  notApplicable,
  pass,
  requireEvidence,
} from "./shared.js";
import {
  evaluateValidationObserved,
  expectedValidationCommandsFromEvidence,
  normalizeShellToolCalls,
} from "./validation-match.js";
import { skippedOutcome } from "../outcomes.js";

function requireRevisionCycle(ctx: EvaluationContext): EvaluatorOutcome | null {
  if (ctx.subject.subjectType !== "revision_cycle") {
    return notApplicable(
      "not_revision_cycle",
      "Evaluator applies only to revision_cycle subjects.",
    );
  }
  return null;
}

export async function evaluateFeedbackIdentityPresent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireRevisionCycle(ctx);
  if (na) return na;
  const skip = requireEvidence(ctx, ["manifest"]);
  if (skip) return skip;
  const id =
    ctx.subject.pmFeedbackCommentId ?? ctx.manifest?.pmFeedbackCommentId;
  if (!id) {
    return fail(
      "feedback_identity_missing",
      "PM feedback comment ID is missing.",
    );
  }
  return pass("feedback_identity_present", "PM feedback identity is present.");
}

export async function evaluateFeedbackArtifactPresent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireRevisionCycle(ctx);
  if (na) return na;
  const resolved = evidenceOrSkip(ctx, "pm_feedback");
  if ("skip" in resolved) {
    if (resolved.skip.reasonCode === "missing_required_evidence") {
      return fail(
        "feedback_artifact_absent",
        "PM feedback artifact is absent.",
      );
    }
    return resolved.skip;
  }
  return pass(
    "feedback_artifact_present",
    "PM feedback artifact is present and verified.",
  );
}

export async function evaluateRevisionProcessedOnce(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireRevisionCycle(ctx);
  if (na) return na;
  const feedbackId = ctx.subject.pmFeedbackCommentId;
  if (!feedbackId) {
    return skippedOutcome(
      "insufficient_evidence",
      "feedback_identity_missing",
      "Cannot assess uniqueness without feedback identity.",
    );
  }
  const cycles = ctx.sessionSubjects.filter(
    (s) =>
      s.subjectType === "revision_cycle" &&
      s.pmFeedbackCommentId === feedbackId,
  );
  if (cycles.length === 0) {
    return fail(
      "revision_cycle_missing",
      "No revision_cycle subjects found for feedback ID.",
    );
  }
  if (cycles.length > 1) {
    return fail(
      "revision_processed_multiple",
      `Feedback ID used by ${cycles.length} revision_cycle subjects.`,
    );
  }
  return pass(
    "revision_processed_once",
    "Exactly one revision_cycle uses the feedback ID.",
  );
}

export async function evaluateBuilderContinuityPreserved(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireRevisionCycle(ctx);
  if (na) return na;
  const skip = requireEvidence(ctx, ["manifest"]);
  if (skip) return skip;
  const m = ctx.manifest;
  if (!m) return fail("manifest_unreadable", "Manifest unreadable.");
  if (!m.previousImplementationRunId && !m.previousHandoffRunId) {
    return skippedOutcome(
      "insufficient_evidence",
      "builder_lineage_missing",
      "Previous implementation/handoff run IDs absent.",
    );
  }
  return pass(
    "builder_continuity_preserved",
    "Previous implementation/handoff relationships are present.",
  );
}

export async function evaluateSamePrPreserved(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireRevisionCycle(ctx);
  if (na) return na;
  const skip = requireEvidence(ctx, ["manifest"]);
  if (skip) return skip;
  if (!ctx.manifest?.prUrl && !ctx.manifest?.branch) {
    return skippedOutcome(
      "insufficient_evidence",
      "pr_identity_missing",
      "PR/branch identity absent on revision manifest.",
    );
  }
  return pass(
    "same_pr_preserved",
    "Revision remains attached to PR/branch identity.",
  );
}

export async function evaluatePostRevisionValidationObserved(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireRevisionCycle(ctx);
  if (na) return na;
  const tel = ctx.evidence.telemetry;
  if (!tel?.present || tel.untrusted) {
    return skippedOutcome(
      "insufficient_evidence",
      "validation_telemetry_unavailable",
      "Telemetry unavailable for post-revision validation check.",
    );
  }
  const { commands } = expectedValidationCommandsFromEvidence({
    promptContent: ctx.evidence.prompt?.content ?? null,
    manifestValidationSummary: ctx.manifest?.validationSummary ?? null,
  });
  if (commands.length === 0) {
    return notApplicable(
      "post_revision_validation_not_required",
      "No expected validation commands declared for this revision.",
    );
  }
  return evaluateValidationObserved({
    expected: commands,
    toolCalls: normalizeShellToolCalls(ctx.telemetryEvents),
  });
}

export async function evaluateRevisionOutputPresent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireRevisionCycle(ctx);
  if (na) return na;
  const resolved = evidenceOrSkip(ctx, "agent_output");
  if ("skip" in resolved) {
    if (resolved.skip.reasonCode === "missing_required_evidence") {
      return fail("revision_output_absent", "Revision output artifact absent.");
    }
    return resolved.skip;
  }
  return pass(
    "revision_output_present",
    "Revision output artifact is present and verified.",
  );
}
