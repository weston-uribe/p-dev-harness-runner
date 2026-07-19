import { createHash } from "node:crypto";
import { deriveEvaluationSessionId } from "../telemetry/ids.js";

const SUBJECT_PREFIX = "p-dev:eval-subject:v1";

function sha256Hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function derivePhaseExecutionSubjectId(phaseExecutionId: string): string {
  return sha256Hex(
    `${SUBJECT_PREFIX}:phase_execution:${phaseExecutionId}`,
  );
}

export function deriveRevisionCycleSubjectId(
  evaluationSessionId: string,
  pmFeedbackCommentId: string,
): string {
  return sha256Hex(
    `${SUBJECT_PREFIX}:revision_cycle:${evaluationSessionId}:${pmFeedbackCommentId}`,
  );
}

export function deriveWorkflowSessionSubjectId(
  evaluationSessionId: string,
): string {
  return sha256Hex(
    `${SUBJECT_PREFIX}:workflow_session:${evaluationSessionId}`,
  );
}

export function deriveAgentRunSubjectId(
  phaseExecutionId: string,
  agentId: string,
  agentRunId: string,
): string {
  return sha256Hex(
    `${SUBJECT_PREFIX}:agent_run:${phaseExecutionId}:${agentId}:${agentRunId}`,
  );
}

export function deriveToolCallSubjectId(
  phaseExecutionId: string,
  toolCallId: string,
): string {
  return sha256Hex(
    `${SUBJECT_PREFIX}:tool_call:${phaseExecutionId}:${toolCallId}`,
  );
}

export { deriveEvaluationSessionId };
