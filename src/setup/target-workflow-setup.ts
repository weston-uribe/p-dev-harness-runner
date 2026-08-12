import { createHash } from "node:crypto";
import { buildRepositoryDispatchUrl } from "../webhook/dispatch-github.js";
import {
  formatHarnessDispatchRepo,
  type HarnessDispatchRepoResolution,
} from "./harness-dispatch-repo.js";
import { generateTargetRepoWorkflowInstructions } from "./generated-instructions.js";
import {
  REMOTE_SETUP_ACTIONS,
  TARGET_WORKFLOW_PATH,
  type RemoteWorkflowStatus,
} from "./remote-actions.js";
import { computeTargetWorkflowFingerprint } from "./remote-preview-fingerprint.js";
import { targetRepoSlugFromUrl } from "./harness-secret-setup.js";
import {
  buildTargetWorkflowContractComment,
  classifyTargetWorkflowAgainstContract,
  TARGET_WORKFLOW_CONTRACT_VERSION,
} from "./target-workflow-contract.js";

export interface TargetWorkflowGenerationInput {
  harnessDispatchRepo: string;
  repoConfigId: string;
  targetRepoSlug: string;
  productionBranch: string;
}

export function buildTargetWorkflowBranchName(repoConfigId: string): string {
  return `harness/setup-production-sync-${repoConfigId}`;
}

export function buildTargetWorkflowPrTitle(upgrade = false): string {
  return upgrade
    ? "Upgrade harness production sync workflow"
    : "Install harness production sync workflow";
}

export function buildTargetWorkflowPrBody(input: {
  repoConfigId: string;
  productionBranch: string;
  harnessDispatchRepo: string;
  upgrade?: boolean;
}): string {
  const verb = input.upgrade ? "Upgrade" : "Install";
  return [
    `${verb} the harness production sync workflow via Product Development Harness setup.`,
    "",
    `- Repo config id: ${input.repoConfigId}`,
    `- Production branch watched: ${input.productionBranch}`,
    `- Harness dispatch repo: ${input.harnessDispatchRepo}`,
    `- Target workflow contract: v${TARGET_WORKFLOW_CONTRACT_VERSION}`,
    "",
    "This workflow dispatches `production_promoted` to the harness repo after production branch pushes.",
    "It does not run harness planning, implementation, handoff, revision, or merge phases.",
    "",
    "Required target repo secret: `HARNESS_DISPATCH_TOKEN` (dispatch-only PAT scoped to the harness repo).",
    "",
    `<!-- p-dev-workflow-install:${input.repoConfigId} -->`,
    `<!-- ${"p-dev-target-workflow-contract"}:v${TARGET_WORKFLOW_CONTRACT_VERSION} -->`,
  ].join("\n");
}

export function generateTargetWorkflowYaml(
  input: TargetWorkflowGenerationInput,
): string {
  const dispatchUrl = buildRepositoryDispatchUrl(input.harnessDispatchRepo);
  const contractComment = buildTargetWorkflowContractComment({
    contractVersion: TARGET_WORKFLOW_CONTRACT_VERSION,
    harnessDispatchRepo: input.harnessDispatchRepo,
    repoConfigId: input.repoConfigId,
    productionBranch: input.productionBranch,
  });

  return [
    contractComment,
    "name: Trigger harness production sync",
    "",
    "on:",
    "  push:",
    `    branches: [${input.productionBranch}]`,
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  dispatch:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Dispatch production_promoted to harness",
    "        env:",
    "          HARNESS_DISPATCH_TOKEN: ${{ secrets.HARNESS_DISPATCH_TOKEN }}",
    "        run: |",
    "          curl -fsS -X POST \\",
    '            -H "Authorization: Bearer ${HARNESS_DISPATCH_TOKEN}" \\',
    '            -H "Accept: application/vnd.github+json" \\',
    '            -H "X-GitHub-Api-Version: 2022-11-28" \\',
    `            ${dispatchUrl} \\`,
    '            -d "$(jq -n \\',
    `              --arg repo ${input.repoConfigId} \\`,
    `              --arg branch ${input.productionBranch} \\`,
    `              --arg source ${input.targetRepoSlug} \\`,
    '              --arg after "${{ github.sha }}" \\',
    '              --arg ref "${{ github.ref }}" \\',
    '              --arg run_id "${{ github.run_id }}" \\',
    '              --arg received "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\',
    `              '{event_type:"production_promoted", client_payload:{repo:$repo, productionBranch:$branch, sourceRepo:$source, after:$after, ref:$ref, githubRunId:$run_id, receivedAt:$received}}')"`,
    "",
  ].join("\n");
}

export function hashWorkflowContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function compareTargetWorkflowContent(
  existingContent: string | null | undefined,
  intendedContent: string,
): RemoteWorkflowStatus {
  const intendedDispatchRepo =
    intendedContent.match(
      /https:\/\/api\.github\.com\/repos\/([^/\s]+)\/([^/\s]+)\/dispatches/,
    );
  const intendedRepo = intendedDispatchRepo
    ? `${intendedDispatchRepo[1]}/${intendedDispatchRepo[2]}`
    : "";

  return classifyTargetWorkflowAgainstContract({
    existingContent,
    intendedContent,
    intendedDispatchRepo: intendedRepo,
    intendedContractVersion: TARGET_WORKFLOW_CONTRACT_VERSION,
  });
}

export function buildTargetWorkflowPrPlan(input: {
  repoConfigId: string;
  targetRepo: string;
  productionBranch: string;
  harnessDispatchRepo: HarnessDispatchRepoResolution;
  workflowStatus?: RemoteWorkflowStatus;
}): {
  plan: {
    repoConfigId: string;
    targetRepoSlug: string;
    harnessDispatchRepo: string;
    productionBranch: string;
    workflowPath: string;
    branchName: string;
    prTitle: string;
    prBody: string;
    workflowStatus: RemoteWorkflowStatus;
    directProductionBranchWrite: false;
  };
  workflowContent: string;
  validationError?: string;
} {
  const targetRepoSlug = targetRepoSlugFromUrl(input.targetRepo);
  if (!targetRepoSlug) {
    return {
      plan: {
        repoConfigId: input.repoConfigId,
        targetRepoSlug: "<invalid-target-repo>",
        harnessDispatchRepo: formatHarnessDispatchRepo(input.harnessDispatchRepo),
        productionBranch: input.productionBranch,
        workflowPath: TARGET_WORKFLOW_PATH,
        branchName: buildTargetWorkflowBranchName(input.repoConfigId),
        prTitle: buildTargetWorkflowPrTitle(),
        prBody: buildTargetWorkflowPrBody({
          repoConfigId: input.repoConfigId,
          productionBranch: input.productionBranch,
          harnessDispatchRepo: formatHarnessDispatchRepo(
            input.harnessDispatchRepo,
          ),
        }),
        workflowStatus: "unknown",
        directProductionBranchWrite: false,
      },
      workflowContent: "",
      validationError: `Invalid target repo URL: ${input.targetRepo}`,
    };
  }

  const harnessDispatchRepo = formatHarnessDispatchRepo(input.harnessDispatchRepo);
  const workflowContent = generateTargetWorkflowYaml({
    harnessDispatchRepo,
    repoConfigId: input.repoConfigId,
    targetRepoSlug,
    productionBranch: input.productionBranch,
  });

  return {
    plan: {
      repoConfigId: input.repoConfigId,
      targetRepoSlug,
      harnessDispatchRepo,
      productionBranch: input.productionBranch,
      workflowPath: TARGET_WORKFLOW_PATH,
      branchName: buildTargetWorkflowBranchName(input.repoConfigId),
      prTitle: buildTargetWorkflowPrTitle(),
      prBody: buildTargetWorkflowPrBody({
        repoConfigId: input.repoConfigId,
        productionBranch: input.productionBranch,
        harnessDispatchRepo,
      }),
      workflowStatus: input.workflowStatus ?? "unknown",
      directProductionBranchWrite: false,
    },
    workflowContent,
  };
}

export function summarizeTargetWorkflowPreview(plan: {
  workflowPath: string;
  branchName: string;
  productionBranch: string;
  harnessDispatchRepo: string;
  workflowStatus: RemoteWorkflowStatus;
}): string {
  return [
    `Workflow path: ${plan.workflowPath}`,
    `Install branch: ${plan.branchName}`,
    `PR base branch: ${plan.productionBranch}`,
    `Harness dispatch repo: ${plan.harnessDispatchRepo}`,
    `Workflow status: ${plan.workflowStatus}`,
    "Direct production branch write: never",
  ].join("\n");
}

export function previewTargetWorkflowSetup(input: {
  repoConfigId: string;
  targetRepo: string;
  productionBranch: string;
  harnessDispatchRepo: HarnessDispatchRepoResolution;
  workflowStatus?: RemoteWorkflowStatus;
  productionBranchSha?: string;
}): {
  plan: ReturnType<typeof buildTargetWorkflowPrPlan>["plan"];
  workflowContent: string;
  workflowPreviewSummary: string;
  fingerprint: string;
  manualInstructions: string[];
  validationError?: string;
} {
  const built = buildTargetWorkflowPrPlan(input);
  const manualInstructions = generateTargetRepoWorkflowInstructions({
    harnessRepo: built.plan.harnessDispatchRepo,
    repoConfigId: built.plan.repoConfigId,
    targetRepoSlug: built.plan.targetRepoSlug,
    productionBranch: built.plan.productionBranch,
  }).steps;

  const fingerprint = computeTargetWorkflowFingerprint({
    actionId: REMOTE_SETUP_ACTIONS.previewTargetWorkflowPr.id,
    permissionScope:
      REMOTE_SETUP_ACTIONS.previewTargetWorkflowPr.permission.scope,
    repoConfigId: built.plan.repoConfigId,
    targetRepoSlug: built.plan.targetRepoSlug,
    harnessDispatchRepo: built.plan.harnessDispatchRepo,
    productionBranch: built.plan.productionBranch,
    workflowPath: built.plan.workflowPath,
    branchName: built.plan.branchName,
    workflowContentHash: hashWorkflowContent(built.workflowContent),
    productionBranchSha: input.productionBranchSha,
  });

  return {
    plan: built.plan,
    workflowContent: built.workflowContent,
    workflowPreviewSummary: summarizeTargetWorkflowPreview(built.plan),
    fingerprint,
    manualInstructions,
    validationError: built.validationError,
  };
}
