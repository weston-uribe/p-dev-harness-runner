import { writeFile } from "node:fs/promises";
import type { RunManifest } from "../types/run.js";
import type { ParsedIssue } from "../types/parsed-issue.js";
import type { ResolvedTarget } from "../resolver/target-repo.js";
import type { CursorCancelOutcome } from "../agents/types.js";
import { getSummaryPath } from "./paths.js";
import { detectExecutionEnvironment } from "../runner/execution-environment.js";

export interface RunSummaryExtras {
  cursorCleanup?: CursorCancelOutcome | null;
}

function formatCursorCleanup(status: CursorCancelOutcome | null | undefined): string {
  switch (status) {
    case "cancelled":
      return "Cursor run cancel requested and completed";
    case "cancel_unavailable":
      return "Cursor run cancel unavailable (SDK does not support cancel for this run)";
    case "cancel_failed":
      return "Cursor run cancel requested but failed";
    default:
      return "n/a";
  }
}

export async function writeRunSummary(
  runDirectory: string,
  manifest: RunManifest,
  parsed: ParsedIssue,
  resolved: ResolvedTarget | null,
  extras: RunSummaryExtras = {},
): Promise<void> {
  const executionEnvironment = detectExecutionEnvironment();
  const lines = [
    "# Harness run summary",
    "",
    `- **Execution environment:** ${executionEnvironment.marker}`,
    `- **Run ID:** ${manifest.runId}`,
    `- **Issue:** ${manifest.issueKey}`,
    `- **Milestone:** ${manifest.milestone}`,
    `- **Dry run:** ${manifest.dryRun}`,
    `- **Outcome:** ${manifest.finalOutcome}`,
    `- **Error classification:** ${manifest.errorClassification ?? "none"}`,
    `- **Phase (inferred):** ${manifest.phase}`,
    `- **Status:** ${manifest.phaseInferredFromStatus ?? "unknown"}`,
    `- **Linear status before:** ${manifest.linearStatusBefore ?? "unknown"}`,
    `- **Linear status after:** ${manifest.linearStatusAfter ?? "unknown"}`,
    `- **Model:** ${manifest.model ?? "n/a"}`,
    `- **Prompt version:** ${manifest.promptVersion ?? "n/a"}`,
    `- **Cursor agent ID:** ${manifest.cursorAgentId ?? "n/a"}`,
    `- **Cursor run ID:** ${manifest.cursorRunId ?? "n/a"}`,
    `- **Branch:** ${manifest.branch ?? "n/a"}`,
    `- **PR URL:** ${manifest.prUrl ?? "n/a"}`,
    `- **Preview URL:** ${manifest.previewUrl ?? "n/a"}`,
    `- **Changed files:** ${manifest.changedFiles?.length ?? 0}`,
    `- **Check summary:** ${manifest.checkSummary ?? "n/a"}`,
    `- **Previous implementation run ID:** ${manifest.previousImplementationRunId ?? "n/a"}`,
    `- **Previous handoff run ID:** ${manifest.previousHandoffRunId ?? "n/a"}`,
    `- **PM feedback comment ID:** ${manifest.pmFeedbackCommentId ?? "n/a"}`,
    `- **Previous revision run ID:** ${manifest.previousRevisionRunId ?? "n/a"}`,
    `- **Merge commit SHA:** ${manifest.mergeCommitSha ?? "n/a"}`,
    `- **Merge method:** ${manifest.mergeMethod ?? "n/a"}`,
    `- **Merged at:** ${manifest.mergedAt ?? "n/a"}`,
    `- **Deployment URL:** ${manifest.deploymentUrl ?? "n/a"}`,
    `- **Validation summary:** ${manifest.validationSummary ?? "n/a"}`,
    `- **Cursor cleanup:** ${formatCursorCleanup(extras.cursorCleanup)}`,
    "",
    "## Task",
    parsed.task || "_not parsed_",
    "",
  ];

  if (resolved) {
    lines.push(
      "## Target repo resolution",
      `- **Repo:** ${resolved.targetRepo}`,
      `- **Base branch:** ${resolved.baseBranch}`,
      `- **Config ID:** ${resolved.repoConfigId}`,
      `- **Source:** ${resolved.resolutionSource}`,
      `- **Preview provider:** ${resolved.previewProvider}`,
      "",
    );
  } else {
    lines.push("## Target repo resolution", "_not resolved_", "");
  }

  if (parsed.parseErrors.length > 0) {
    lines.push("## Parse errors", ...parsed.parseErrors.map((e) => `- ${e}`), "");
  }

  lines.push(
    "## Artifacts",
    `- Manifest: \`${runDirectory}/manifest.json\``,
    `- Events: \`${runDirectory}/events.jsonl\``,
    `- Issue snapshot (before): \`${runDirectory}/linear/issue-snapshot-before.json\``,
    `- Issue snapshot (after): \`${runDirectory}/linear/issue-snapshot-after.json\``,
    `- Planning prompt: \`${runDirectory}/prompts/planning-agent.md\``,
    `- Planning result: \`${runDirectory}/outputs/planning-result.md\``,
    `- Planning comment loaded: \`${runDirectory}/linear/planning-comment-loaded.md\``,
    `- Implementation prompt: \`${runDirectory}/prompts/implementation-agent.md\``,
    `- Implementation result: \`${runDirectory}/outputs/implementation-result.md\``,
    `- Cursor run result: \`${runDirectory}/cursor/run-result.json\``,
    `- PR metadata: \`${runDirectory}/github/pr-metadata.json\``,
    `- GitHub PR inspect: \`${runDirectory}/github/pr.json\``,
    `- GitHub checks: \`${runDirectory}/github/checks.json\``,
    `- Vercel deployment: \`${runDirectory}/vercel/deployment.json\``,
    `- Implementation comment loaded: \`${runDirectory}/linear/implementation-comment-loaded.md\``,
    `- Handoff comment: \`${runDirectory}/linear/handoff-comment.md\``,
    `- Merge source comment loaded: \`${runDirectory}/linear/merge-source-comment-loaded.md\``,
    `- Merge completion comment: \`${runDirectory}/linear/merge-completion-comment.md\``,
    `- Comments written: \`${runDirectory}/linear/comments-written.md\``,
    "",
  );

  await writeFile(getSummaryPath(runDirectory), `${lines.join("\n")}\n`, "utf8");
}
