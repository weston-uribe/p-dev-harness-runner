import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LinearIssueSnapshot } from "../linear/client.js";
import type { ParsedIssue } from "../types/parsed-issue.js";
import type { ResolvedTarget } from "../resolver/target-repo.js";
import { INTEGRATION_REPAIR_PROMPT_VERSION } from "../config/defaults.js";

const integrationRepairTemplatePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "integration-repair.md",
);

function formatList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "_none_";
}

export interface BuildIntegrationRepairPromptParams {
  issue: LinearIssueSnapshot;
  parsed: ParsedIssue;
  resolved: ResolvedTarget;
  branch: string;
  prUrl: string;
  baseHeadSha: string;
  conflictFiles: string[];
  changedFiles: string[];
  baseBranchDelta: string[];
  validationCommands: string[];
}

export async function buildIntegrationRepairPrompt(
  params: BuildIntegrationRepairPromptParams,
): Promise<{ prompt: string; promptVersion: string }> {
  const template = await readFile(integrationRepairTemplatePath, "utf8");
  const validationSection = params.parsed.validationExpectations
    ? `### Validation expectations\n\n${params.parsed.validationExpectations}`
    : "";

  const prompt = template
    .replaceAll("{{promptVersion}}", INTEGRATION_REPAIR_PROMPT_VERSION)
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
    .replaceAll("{{baseBranch}}", params.resolved.baseBranch)
    .replaceAll("{{baseHeadSha}}", params.baseHeadSha)
    .replaceAll("{{productionBranch}}", params.resolved.productionBranch)
    .replaceAll("{{conflictFiles}}", formatList(params.conflictFiles))
    .replaceAll("{{changedFiles}}", formatList(params.changedFiles))
    .replaceAll("{{baseBranchDelta}}", formatList(params.baseBranchDelta))
    .replaceAll(
      "{{validationCommands}}",
      params.validationCommands.length > 0
        ? params.validationCommands.map((cmd) => `- \`${cmd}\``).join("\n")
        : "_none configured_",
    );

  return { prompt, promptVersion: INTEGRATION_REPAIR_PROMPT_VERSION };
}
