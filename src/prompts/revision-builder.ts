import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LinearIssueSnapshot } from "../linear/client.js";
import type { ParsedIssue } from "../types/parsed-issue.js";
import type { ResolvedTarget } from "../resolver/target-repo.js";
import { REVISION_PROMPT_VERSION } from "../config/defaults.js";

const revisionTemplatePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "revision.md",
);

function formatList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "_none_";
}

export interface BuildRevisionPromptParams {
  issue: LinearIssueSnapshot;
  parsed: ParsedIssue;
  resolved: ResolvedTarget;
  runId: string;
  branch: string;
  prUrl: string;
  pmFeedback: string;
  changedFiles: string[];
  validationCommands: string[];
}

export async function buildRevisionPrompt(
  params: BuildRevisionPromptParams,
): Promise<{ prompt: string; promptVersion: string }> {
  const template = await readFile(revisionTemplatePath, "utf8");
  const validationSection = params.parsed.validationExpectations
    ? `### Validation expectations\n\n${params.parsed.validationExpectations}`
    : "";

  const prompt = template
    .replaceAll("{{promptVersion}}", REVISION_PROMPT_VERSION)
    .replaceAll("{{issueKey}}", params.issue.identifier)
    .replaceAll("{{issueTitle}}", params.issue.title)
    .replaceAll("{{issueUrl}}", params.issue.url ?? "n/a")
    .replaceAll("{{task}}", params.parsed.task)
    .replaceAll("{{acceptanceCriteria}}", formatList(params.parsed.acceptanceCriteria))
    .replaceAll("{{outOfScope}}", formatList(params.parsed.outOfScope))
    .replaceAll("{{validationExpectations}}", validationSection)
    .replaceAll("{{targetRepo}}", params.resolved.targetRepo)
    .replaceAll("{{branch}}", params.branch)
    .replaceAll("{{prUrl}}", params.prUrl)
    .replaceAll("{{pmFeedback}}", params.pmFeedback.trim())
    .replaceAll("{{changedFiles}}", formatList(params.changedFiles))
    .replaceAll(
      "{{validationCommands}}",
      params.validationCommands.length > 0
        ? params.validationCommands.map((cmd) => `- \`${cmd}\``).join("\n")
        : "_none configured_",
    )
    .replaceAll("{{runId}}", params.runId);

  return { prompt, promptVersion: REVISION_PROMPT_VERSION };
}
