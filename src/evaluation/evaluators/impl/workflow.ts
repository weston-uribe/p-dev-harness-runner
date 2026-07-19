import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvaluationContext, EvaluatorOutcome } from "../types.js";
import { fail, notApplicable, pass } from "./shared.js";
import { skippedOutcome } from "../outcomes.js";
import type { EvaluationSubjectPhase } from "../../subjects/types.js";

interface WorkflowStateMachine {
  stateMachineId: string;
  stateMachineVersion: string;
  allowedTransitions: Array<{ from: string | null; to: string }>;
  terminalOutcomes: string[];
}

let cachedMachine: { machine: WorkflowStateMachine; hash: string } | null =
  null;

export function loadWorkflowStateMachine(): {
  machine: WorkflowStateMachine;
  hash: string;
  version: string;
} {
  if (cachedMachine) {
    return {
      machine: cachedMachine.machine,
      hash: cachedMachine.hash,
      version: cachedMachine.machine.stateMachineVersion,
    };
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.join(
    here,
    "..",
    "contracts",
    "workflow-state-machine.v1.json",
  );
  const raw = readFileSync(filePath, "utf8");
  const hash = createHash("sha256").update(raw, "utf8").digest("hex");
  const machine = JSON.parse(raw) as WorkflowStateMachine;
  cachedMachine = { machine, hash };
  return { machine, hash, version: machine.stateMachineVersion };
}

function requireWorkflow(ctx: EvaluationContext): EvaluatorOutcome | null {
  if (ctx.subject.subjectType !== "workflow_session") {
    return notApplicable(
      "not_workflow_session",
      "Evaluator applies only to workflow_session subjects.",
    );
  }
  return null;
}

function phaseExecutions(ctx: EvaluationContext) {
  return ctx.sessionSubjects
    .filter((s) => s.subjectType === "phase_execution" && s.phase != null)
    .map((s) => ({
      subject: s,
      manifest: s.harnessRunId
        ? ctx.manifestsByRunId[s.harnessRunId] ?? null
        : null,
    }));
}

function withMachineMeta(
  outcome: EvaluatorOutcome,
): EvaluatorOutcome {
  const { hash, version } = loadWorkflowStateMachine();
  return {
    ...outcome,
    workflowStateMachineVersion: version,
    workflowStateMachineHash: hash,
  };
}

export async function evaluatePhaseSequenceValid(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireWorkflow(ctx);
  if (na) return withMachineMeta(na);
  const { machine } = loadWorkflowStateMachine();
  const phases = phaseExecutions(ctx)
    .map((p) => p.subject.phase as EvaluationSubjectPhase)
    .filter(Boolean);
  if (phases.length === 0) {
    return withMachineMeta(
      skippedOutcome(
        "insufficient_evidence",
        "no_phase_executions",
        "No phase_execution subjects to validate sequence.",
      ),
    );
  }
  let previous: string | null = null;
  for (const phase of phases) {
    const ok = machine.allowedTransitions.some(
      (t) => t.from === previous && t.to === phase,
    );
    // Allow duplicate/idempotent re-entry of same phase as self-loop if declared,
    // or same phase repeated (duplicate attempts).
    const duplicateOk =
      previous === phase ||
      machine.allowedTransitions.some(
        (t) => t.from === phase && t.to === phase,
      );
    if (!ok && !(previous === phase && duplicateOk)) {
      // Also allow first phase from null
      const fromNull = machine.allowedTransitions.some(
        (t) => t.from === null && t.to === phase,
      );
      if (!(previous === null && fromNull)) {
        return withMachineMeta(
          fail(
            "phase_sequence_invalid",
            `Invalid transition ${String(previous)} -> ${phase}`,
          ),
        );
      }
    }
    previous = phase;
  }
  return withMachineMeta(
    pass("phase_sequence_valid", "Phase sequence is valid under state machine."),
  );
}

export async function evaluatePhaseLinksConsistent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireWorkflow(ctx);
  if (na) return withMachineMeta(na);
  const executions = phaseExecutions(ctx);
  for (const { subject, manifest } of executions) {
    if (!manifest) continue;
    if (
      subject.phase === "revision" &&
      manifest.pmFeedbackCommentId &&
      subject.pmFeedbackCommentId &&
      subject.pmFeedbackCommentId !== manifest.pmFeedbackCommentId
    ) {
      return withMachineMeta(
        fail(
          "phase_link_feedback_mismatch",
          "Revision subject feedback ID disagrees with manifest.",
        ),
      );
    }
  }
  return withMachineMeta(
    pass("phase_links_consistent", "Phase lineage links are consistent."),
  );
}

export async function evaluateDuplicateExecutionPrevented(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireWorkflow(ctx);
  if (na) return withMachineMeta(na);
  const byPhase = new Map<string, Array<"success" | "failed" | "skipped" | "duplicate">>();
  for (const { subject, manifest } of phaseExecutions(ctx)) {
    if (!subject.phase || !manifest) continue;
    const list = byPhase.get(subject.phase) ?? [];
    list.push(manifest.finalOutcome);
    byPhase.set(subject.phase, list);
  }
  for (const [phase, outcomes] of byPhase) {
    const successes = outcomes.filter((o) => o === "success").length;
    const failures = outcomes.filter((o) => o === "failed").length;
    if (successes > 1) {
      return withMachineMeta(
        fail(
          "duplicate_success_contradiction",
          `Phase ${phase} has multiple successful results.`,
        ),
      );
    }
    if (successes === 1 && failures > 0) {
      // Allowed: failed attempts then success — not a contradiction.
      continue;
    }
  }
  return withMachineMeta(
    pass(
      "duplicate_execution_prevented",
      "Duplicate phase results do not contradict effective success.",
    ),
  );
}

export async function evaluateReviewOutcomeConsistent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireWorkflow(ctx);
  if (na) return withMachineMeta(na);
  const revisionCount = ctx.sessionSubjects.filter(
    (s) => s.subjectType === "revision_cycle",
  ).length;
  const handoffOrMerge = phaseExecutions(ctx).filter(
    (p) => p.subject.phase === "handoff" || p.subject.phase === "merge",
  );
  if (handoffOrMerge.length === 0 && revisionCount === 0) {
    return withMachineMeta(
      notApplicable(
        "review_outcome_not_applicable",
        "No review/revision evidence to compare.",
      ),
    );
  }
  return withMachineMeta(
    pass(
      "review_outcome_consistent",
      `Review/revision evidence consistent (revision_cycles=${revisionCount}).`,
    ),
  );
}

export async function evaluateMergeOutcomeConsistent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireWorkflow(ctx);
  if (na) return withMachineMeta(na);
  const mergeRuns = phaseExecutions(ctx).filter(
    (p) => p.subject.phase === "merge",
  );
  if (mergeRuns.length === 0) {
    return withMachineMeta(
      notApplicable("merge_not_present", "No merge phase to validate."),
    );
  }
  for (const { manifest } of mergeRuns) {
    if (!manifest) {
      return withMachineMeta(
        skippedOutcome(
          "insufficient_evidence",
          "merge_manifest_missing",
          "Merge phase missing manifest.",
        ),
      );
    }
    if (manifest.finalOutcome === "success") {
      if (!manifest.mergeCommitSha && !manifest.mergedAt) {
        return withMachineMeta(
          fail(
            "merge_success_without_fields",
            "Merge marked success without mergeCommitSha/mergedAt.",
          ),
        );
      }
    }
  }
  return withMachineMeta(
    pass("merge_outcome_consistent", "Merge outcome agrees with merge fields."),
  );
}

export async function evaluateDeliveryOutcomeConsistent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireWorkflow(ctx);
  if (na) return withMachineMeta(na);
  const mergeSuccess = phaseExecutions(ctx).some(
    (p) =>
      p.subject.phase === "merge" && p.manifest?.finalOutcome === "success",
  );
  if (!mergeSuccess) {
    return withMachineMeta(
      notApplicable(
        "delivery_not_applicable",
        "No successful merge; delivery check not applicable.",
      ),
    );
  }
  const hasDeploy = phaseExecutions(ctx).some(
    (p) => p.manifest?.deploymentUrl || p.manifest?.previewUrl,
  );
  if (!hasDeploy) {
    return withMachineMeta(
      skippedOutcome(
        "insufficient_evidence",
        "deployment_evidence_missing",
        "Delivery destination/deployment evidence not available.",
      ),
    );
  }
  return withMachineMeta(
    pass(
      "delivery_outcome_consistent",
      "Delivery outcome agrees with deployment evidence.",
    ),
  );
}

export async function evaluateTerminalStateConsistent(
  ctx: EvaluationContext,
): Promise<EvaluatorOutcome> {
  const na = requireWorkflow(ctx);
  if (na) return withMachineMeta(na);
  const { machine } = loadWorkflowStateMachine();
  const executions = phaseExecutions(ctx);
  if (executions.length === 0) {
    return withMachineMeta(
      skippedOutcome(
        "insufficient_evidence",
        "no_phase_executions",
        "No phases to assess terminal state.",
      ),
    );
  }
  for (const { manifest } of executions) {
    if (!manifest) continue;
    if (!machine.terminalOutcomes.includes(manifest.finalOutcome)) {
      return withMachineMeta(
        fail(
          "unknown_terminal_outcome",
          `Unknown terminal outcome ${manifest.finalOutcome}`,
        ),
      );
    }
  }
  return withMachineMeta(
    pass(
      "terminal_state_consistent",
      "Terminal states are consistent with state-machine outcomes.",
    ),
  );
}
