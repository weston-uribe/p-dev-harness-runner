import path from "node:path";

export function getRunDirectory(
  logDirectory: string,
  issueKey: string,
  runId: string,
): string {
  return path.join(logDirectory, issueKey, runId);
}

export function getManifestPath(runDirectory: string): string {
  return path.join(runDirectory, "manifest.json");
}

export function getRuntimeProvenancePath(runDirectory: string): string {
  return path.join(runDirectory, "evaluation", "runtime-provenance.json");
}

export function getEventsPath(runDirectory: string): string {
  return path.join(runDirectory, "events.jsonl");
}

export function getSummaryPath(runDirectory: string): string {
  return path.join(runDirectory, "run-summary.md");
}

export function getIssueSnapshotPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "issue-snapshot-before.json");
}

export function getIssueSnapshotAfterPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "issue-snapshot-after.json");
}

export function getPlanningPromptPath(runDirectory: string): string {
  return path.join(runDirectory, "prompts", "planning-agent.md");
}

export function getPlanningResultPath(runDirectory: string): string {
  return path.join(runDirectory, "outputs", "planning-result.md");
}

export function getPlanReviewPromptPath(runDirectory: string): string {
  return path.join(runDirectory, "prompts", "plan-review-agent.md");
}

export function getPlanReviewResultPath(runDirectory: string): string {
  return path.join(runDirectory, "outputs", "plan-review-result.md");
}

export function getCodeReviewPromptPath(runDirectory: string): string {
  return path.join(runDirectory, "prompts", "code-review-agent.md");
}

export function getCodeReviewResultPath(runDirectory: string): string {
  return path.join(runDirectory, "outputs", "code-review-result.md");
}

export function getCodeRevisionPromptPath(runDirectory: string): string {
  return path.join(runDirectory, "prompts", "code-revision-agent.md");
}

export function getCodeRevisionResultPath(runDirectory: string): string {
  return path.join(runDirectory, "outputs", "code-revision-result.md");
}

export function getPlanArtifactIdentityPath(runDirectory: string): string {
  return path.join(runDirectory, "workflow", "plan-artifact.json");
}

export function getImplementationPromptPath(runDirectory: string): string {
  return path.join(runDirectory, "prompts", "implementation-agent.md");
}

export function getImplementationResultPath(runDirectory: string): string {
  return path.join(runDirectory, "outputs", "implementation-result.md");
}

export function getCursorRunResultPath(runDirectory: string): string {
  return path.join(runDirectory, "cursor", "run-result.json");
}

export function getPrMetadataPath(runDirectory: string): string {
  return path.join(runDirectory, "github", "pr-metadata.json");
}

export function getPlanningCommentLoadedPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "planning-comment-loaded.md");
}

export function getImplementationCommentLoadedPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "implementation-comment-loaded.md");
}

export function getHandoffCommentPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "handoff-comment.md");
}

export function getGithubPrPath(runDirectory: string): string {
  return path.join(runDirectory, "github", "pr.json");
}

export function getGithubChecksPath(runDirectory: string): string {
  return path.join(runDirectory, "github", "checks.json");
}

export function getVercelDeploymentPath(runDirectory: string): string {
  return path.join(runDirectory, "vercel", "deployment.json");
}

export function getCommentsWrittenPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "comments-written.md");
}

export function getHandoffCommentLoadedPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "handoff-comment-loaded.md");
}

export function getPmFeedbackCommentLoadedPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "pm-feedback-comment-loaded.md");
}

export function getRevisionPromptPath(runDirectory: string): string {
  return path.join(runDirectory, "prompts", "revision-agent.md");
}

export function getRevisionResultPath(runDirectory: string): string {
  return path.join(runDirectory, "outputs", "revision-result.md");
}

export function getRevisionCommentPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "revision-comment.md");
}

export function getGithubPrBeforePath(runDirectory: string): string {
  return path.join(runDirectory, "github", "pr-before.json");
}

export function getGithubPrAfterPath(runDirectory: string): string {
  return path.join(runDirectory, "github", "pr-after.json");
}

export function getGithubPrBeforeMergePath(runDirectory: string): string {
  return path.join(runDirectory, "github", "pr-before-merge.json");
}

export function getGithubPrAfterMergePath(runDirectory: string): string {
  return path.join(runDirectory, "github", "pr-after-merge.json");
}

export function getGithubChecksBeforeMergePath(runDirectory: string): string {
  return path.join(runDirectory, "github", "checks-before-merge.json");
}

export function getGithubMergeResultPath(runDirectory: string): string {
  return path.join(runDirectory, "github", "merge-result.json");
}

export function getMergeSourceCommentLoadedPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "merge-source-comment-loaded.md");
}

export function getMergeCompletionCommentPath(runDirectory: string): string {
  return path.join(runDirectory, "linear", "merge-completion-comment.md");
}

export function getProductionDeploymentPath(runDirectory: string): string {
  return path.join(runDirectory, "vercel", "production-deployment.json");
}

export function getMergeRecoveryPath(runDirectory: string): string {
  return path.join(runDirectory, "outputs", "merge-recovery.json");
}

export function getEvaluationOutcomesPath(runDirectory: string): string {
  return path.join(runDirectory, "evaluation", "outcomes.json");
}

export function getAgentTelemetryPath(runDirectory: string): string {
  return path.join(runDirectory, "evaluation", "agent-telemetry.jsonl");
}

export function getTelemetryCompletenessPath(runDirectory: string): string {
  return path.join(runDirectory, "evaluation", "telemetry-completeness.json");
}

export function getErrorPath(runDirectory: string): string {
  return path.join(runDirectory, "errors", "error.json");
}

/** Session-scoped evaluation store under runs/<issueKey>/evaluation/. */
export function getIssueEvaluationDirectory(
  logDirectory: string,
  issueKey: string,
): string {
  return path.join(logDirectory, issueKey, "evaluation");
}

export function getEvaluationSubjectsPath(evaluationDirectory: string): string {
  return path.join(evaluationDirectory, "subjects.jsonl");
}

export function getSubjectExtractionReportPath(
  evaluationDirectory: string,
): string {
  return path.join(evaluationDirectory, "subject-extraction-report.json");
}

export function getEvaluationAnnotationsPath(
  evaluationDirectory: string,
): string {
  return path.join(evaluationDirectory, "annotations.jsonl");
}

export function getAnnotationCoveragePath(
  evaluationDirectory: string,
): string {
  return path.join(evaluationDirectory, "annotation-coverage.json");
}

export function getDatasetReadinessPath(evaluationDirectory: string): string {
  return path.join(evaluationDirectory, "dataset-readiness.json");
}

export function getAnnotationBundlesDirectory(
  evaluationDirectory: string,
): string {
  return path.join(evaluationDirectory, "annotation-bundles");
}

export function getCorrectedOutputsDirectory(
  evaluationDirectory: string,
): string {
  return path.join(evaluationDirectory, "corrected-outputs");
}

export function getEvaluatorResultsPath(evaluationDirectory: string): string {
  return path.join(evaluationDirectory, "evaluator-results.jsonl");
}

export function getEvaluatorRunReportPath(evaluationDirectory: string): string {
  return path.join(evaluationDirectory, "evaluator-run-report.json");
}

export function getEvaluatorSummaryPath(evaluationDirectory: string): string {
  return path.join(evaluationDirectory, "evaluator-summary.json");
}
