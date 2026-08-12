import { createHash } from "node:crypto";
import { HARNESS_LEGACY_ARCHIVED_RUNNER_REPO } from "./harness-template-identity.js";

/** Managed target-workflow contract version. Bump when YAML shape/semantics change. */
export const TARGET_WORKFLOW_CONTRACT_VERSION = 2;

export const TARGET_WORKFLOW_CONTRACT_MARKER_PREFIX =
  "p-dev-target-workflow-contract";

export interface TargetWorkflowContractFields {
  contractVersion: number;
  harnessDispatchRepo: string;
  repoConfigId: string;
  productionBranch: string;
}

export function buildTargetWorkflowContractComment(
  fields: TargetWorkflowContractFields,
): string {
  return [
    `<!-- ${TARGET_WORKFLOW_CONTRACT_MARKER_PREFIX}:v${fields.contractVersion}`,
    `contract_version: ${fields.contractVersion}`,
    `harness_dispatch_repo: ${fields.harnessDispatchRepo}`,
    `repo_config_id: ${fields.repoConfigId}`,
    `production_branch: ${fields.productionBranch}`,
    "-->",
  ].join("\n");
}

export function parseTargetWorkflowContract(
  content: string | null | undefined,
): TargetWorkflowContractFields | null {
  if (!content) {
    return null;
  }

  const markerMatch = content.match(
    /<!--\s*p-dev-target-workflow-contract:v(\d+)([\s\S]*?)-->/,
  );
  if (!markerMatch) {
    return null;
  }

  const body = markerMatch[2] ?? "";
  const contractVersion = Number.parseInt(markerMatch[1] ?? "", 10);
  if (!Number.isFinite(contractVersion)) {
    return null;
  }

  const harnessDispatchRepo =
    body.match(/harness_dispatch_repo:\s*(\S+)/)?.[1] ??
    extractDispatchRepoFromCurl(content);
  const repoConfigId = body.match(/repo_config_id:\s*(\S+)/)?.[1] ?? "";
  const productionBranch =
    body.match(/production_branch:\s*(\S+)/)?.[1] ??
    content.match(/branches:\s*\[([^\]]+)\]/)?.[1]?.trim() ??
    "";

  if (!harnessDispatchRepo) {
    return null;
  }

  return {
    contractVersion,
    harnessDispatchRepo,
    repoConfigId,
    productionBranch,
  };
}

export function extractDispatchRepoFromCurl(content: string): string | null {
  const match = content.match(
    /https:\/\/api\.github\.com\/repos\/([^/\s]+)\/([^/\s]+)\/dispatches/,
  );
  if (!match) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

export function isStaleHarnessDispatchRepo(repoSlug: string | null | undefined): boolean {
  if (!repoSlug) {
    return false;
  }
  const normalized = repoSlug.trim().toLowerCase();
  return (
    normalized === HARNESS_LEGACY_ARCHIVED_RUNNER_REPO.toLowerCase() ||
    normalized.endsWith("/p-dev-harness")
  );
}

export function classifyTargetWorkflowAgainstContract(input: {
  existingContent: string | null | undefined;
  intendedContent: string;
  intendedDispatchRepo: string;
  intendedContractVersion?: number;
}):
  | "present"
  | "missing"
  | "differs"
  | "stale_dispatch_target"
  | "contract_outdated" {
  if (!input.existingContent) {
    return "missing";
  }

  const existingDispatch =
    extractDispatchRepoFromCurl(input.existingContent) ??
    parseTargetWorkflowContract(input.existingContent)?.harnessDispatchRepo ??
    null;

  if (isStaleHarnessDispatchRepo(existingDispatch)) {
    return "stale_dispatch_target";
  }

  const existingContract = parseTargetWorkflowContract(input.existingContent);
  const intendedVersion =
    input.intendedContractVersion ?? TARGET_WORKFLOW_CONTRACT_VERSION;

  if (
    !existingContract ||
    existingContract.contractVersion < intendedVersion
  ) {
    return "contract_outdated";
  }

  if (
    existingDispatch &&
    input.intendedDispatchRepo &&
    existingDispatch.toLowerCase() !== input.intendedDispatchRepo.trim().toLowerCase()
  ) {
    return "differs";
  }

  const existingHash = createHash("sha256")
    .update(input.existingContent)
    .digest("hex");
  const intendedHash = createHash("sha256")
    .update(input.intendedContent)
    .digest("hex");
  if (existingHash === intendedHash) {
    return "present";
  }

  return "differs";
}

export function workflowStatusNeedsUpgrade(
  status:
    | "present"
    | "missing"
    | "differs"
    | "stale_dispatch_target"
    | "contract_outdated"
    | "unknown",
): boolean {
  return (
    status === "missing" ||
    status === "differs" ||
    status === "stale_dispatch_target" ||
    status === "contract_outdated"
  );
}
