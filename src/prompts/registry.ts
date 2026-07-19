/**
 * Prompt definition registry — local templates remain contract authority.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODE_REVISION_PROMPT_VERSION,
  CODE_REVIEW_PROMPT_VERSION,
  IMPLEMENTATION_PROMPT_VERSION,
  INTEGRATION_REPAIR_PROMPT_VERSION,
  PLAN_REVIEW_PROMPT_VERSION,
  PLANNING_PROMPT_VERSION,
  REVISION_PROMPT_VERSION,
} from "../config/defaults.js";
import type { PromptDefinition, PromptVariableSchema } from "./contracts.js";

const promptsDir = path.dirname(fileURLToPath(import.meta.url));

const COMMON_ISSUE_VARS = [
  "promptVersion",
  "issueKey",
  "issueTitle",
  "issueUrl",
  "task",
  "acceptanceCriteria",
  "outOfScope",
  "validationExpectations",
] as const;

function schema(
  required: string[],
  optional: string[] = [],
): PromptVariableSchema {
  return { required, optional };
}

export interface PromptRegistryEntry {
  definition: Omit<PromptDefinition, "localTemplateSha256"> & {
    localTemplateSha256?: string;
  };
  phase: string | null;
  templateFile: string | null;
}

export const PROMPT_REGISTRY: PromptRegistryEntry[] = [
  {
    phase: "planning",
    templateFile: "planning.md",
    definition: {
      name: "p-dev.planning",
      role: "planner",
      contractVersion: PLANNING_PROMPT_VERSION,
      type: "text",
      variableSchema: schema([
        ...COMMON_ISSUE_VARS,
        "targetRepo",
        "baseBranch",
      ]),
      localTemplatePath: "src/prompts/planning.md",
      implemented: true,
    },
  },
  {
    phase: "implementation",
    templateFile: "implementation.md",
    definition: {
      name: "p-dev.implementation",
      role: "implementer",
      contractVersion: IMPLEMENTATION_PROMPT_VERSION,
      type: "text",
      variableSchema: schema([
        ...COMMON_ISSUE_VARS,
        "targetRepo",
        "baseBranch",
        "branchName",
        "planningComment",
        "uninitializedProductContext",
        "validationCommands",
        "runId",
      ]),
      localTemplatePath: "src/prompts/implementation.md",
      implemented: true,
    },
  },
  {
    phase: "revision",
    templateFile: "revision.md",
    definition: {
      name: "p-dev.revision",
      role: "reviser",
      contractVersion: REVISION_PROMPT_VERSION,
      type: "text",
      variableSchema: schema([
        ...COMMON_ISSUE_VARS,
        "branch",
        "prUrl",
        "pmFeedback",
        "changedFiles",
      ]),
      localTemplatePath: "src/prompts/revision.md",
      implemented: true,
    },
  },
  {
    phase: "integration_repair",
    templateFile: "integration-repair.md",
    definition: {
      name: "p-dev.integration-repair",
      role: "integration_repairer",
      contractVersion: INTEGRATION_REPAIR_PROMPT_VERSION,
      type: "text",
      variableSchema: schema([
        ...COMMON_ISSUE_VARS,
        "targetRepo",
        "baseBranch",
        "baseHeadSha",
        "productionBranch",
        "conflictFiles",
        "baseBranchDelta",
      ]),
      localTemplatePath: "src/prompts/integration-repair.md",
      implemented: true,
    },
  },
  {
    phase: "plan_review",
    templateFile: "plan-review.md",
    definition: {
      name: "p-dev.plan-review",
      role: "plan_reviewer",
      contractVersion: PLAN_REVIEW_PROMPT_VERSION,
      type: "text",
      variableSchema: schema(
        [
          ...COMMON_ISSUE_VARS,
          "planGenerationId",
          "planArtifactHash",
          "plannerRunId",
          "planPromptContractVersion",
          "planWorkflowStateRevision",
          "planBody",
          "architectureContext",
          "planningStandards",
          "previousAcceptedFeedback",
          "planReviewCycle",
          "planReviewCycleLimit",
        ],
        ["targetRepo", "baseBranch"],
      ),
      localTemplatePath: "src/prompts/plan-review.md",
      implemented: true,
    },
  },
  {
    phase: "code_review",
    templateFile: "code-review.md",
    definition: {
      name: "p-dev.code-review",
      role: "code_reviewer",
      contractVersion: CODE_REVIEW_PROMPT_VERSION,
      type: "text",
      variableSchema: schema(
        [
          ...COMMON_ISSUE_VARS,
          "reviewedPrNumber",
          "reviewedHeadSha",
          "reviewedBaseSha",
          "reviewedDiffHash",
          "prUrl",
          "targetRepository",
          "changedFilesSummary",
          "testEvidence",
          "priorAcceptedFeedback",
          "codeReviewCycle",
          "codeReviewCycleLimit",
          "approvedPlanIdentity",
          "architectureContext",
          "repositoryPolicies",
        ],
        ["targetRepo", "baseBranch"],
      ),
      localTemplatePath: "src/prompts/code-review.md",
      implemented: true,
    },
  },
  {
    phase: "code_revision",
    templateFile: "code-revision.md",
    definition: {
      name: "p-dev.code-revision",
      role: "code_reviser",
      contractVersion: CODE_REVISION_PROMPT_VERSION,
      type: "text",
      variableSchema: schema(
        [
          ...COMMON_ISSUE_VARS,
          "reviewedPrNumber",
          "reviewedHeadSha",
          "reviewedBaseSha",
          "reviewedDiffHash",
          "prUrl",
          "targetRepository",
          "branch",
          "blockingFindings",
          "causedByReviewDecisionIdentity",
          "currentHeadSha",
          "currentDiffHash",
          "testEvidence",
          "codeReviewCycle",
          "codeReviewCycleLimit",
          "approvedPlanIdentity",
          "architectureContext",
          "repositoryPolicies",
        ],
        ["targetRepo", "baseBranch"],
      ),
      localTemplatePath: "src/prompts/code-revision.md",
      implemented: true,
    },
  },
];

export function getRegistryEntryByPhase(
  phase: string,
): PromptRegistryEntry | undefined {
  return PROMPT_REGISTRY.find((e) => e.phase === phase);
}

export function getRegistryEntryByName(
  name: string,
): PromptRegistryEntry | undefined {
  return PROMPT_REGISTRY.find((e) => e.definition.name === name);
}

export async function loadPromptDefinition(
  name: string,
): Promise<PromptDefinition | null> {
  const entry = getRegistryEntryByName(name);
  if (!entry || !entry.definition.implemented || !entry.templateFile) {
    return null;
  }
  const abs = path.join(promptsDir, entry.templateFile);
  const content = await readFile(abs, "utf8");
  const localTemplateSha256 = createHash("sha256")
    .update(content)
    .digest("hex");
  return {
    ...entry.definition,
    localTemplateSha256,
  };
}

export function listImplementedPromptNames(): string[] {
  return PROMPT_REGISTRY.filter((e) => e.definition.implemented).map(
    (e) => e.definition.name,
  );
}

export function extractVariableNames(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{\{(\w+)\}\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}

export function compileTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  let out = template;
  for (const [key, value] of Object.entries(variables)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
