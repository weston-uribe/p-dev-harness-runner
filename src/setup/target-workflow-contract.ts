import { createHash } from "node:crypto";
import { HARNESS_LEGACY_ARCHIVED_RUNNER_REPO } from "./harness-template-identity.js";

/** Managed target-workflow contract version. Bump when YAML shape/semantics change. */
export const TARGET_WORKFLOW_CONTRACT_VERSION = 3;

export const TARGET_WORKFLOW_CONTRACT_MARKER_PREFIX =
  "p-dev-target-workflow-contract";

export const TARGET_WORKFLOW_GENERATED_BY = "p-dev-harness";

export interface TargetWorkflowContractFields {
  contractVersion: number;
  harnessDispatchRepo: string;
  repoConfigId: string;
  productionBranch: string;
}

/** True when the workflow file uses the invalid HTML contract marker (breaks GHA YAML). */
export function hasInvalidHtmlContractMarker(
  content: string | null | undefined,
): boolean {
  if (!content) {
    return false;
  }
  return /<!--\s*p-dev-target-workflow-contract:v\d+/.test(content);
}

export function buildTargetWorkflowContractComment(
  fields: TargetWorkflowContractFields,
): string {
  return [
    `# ${TARGET_WORKFLOW_CONTRACT_MARKER_PREFIX}:v${fields.contractVersion}`,
    `# generated-by: ${TARGET_WORKFLOW_GENERATED_BY}`,
    `# contract_version: ${fields.contractVersion}`,
    `# harness_dispatch_repo: ${fields.harnessDispatchRepo}`,
    `# repo_config_id: ${fields.repoConfigId}`,
    `# production_branch: ${fields.productionBranch}`,
  ].join("\n");
}

function parseYamlContractComment(
  content: string,
): TargetWorkflowContractFields | null {
  const markerMatch = content.match(
    /^#\s*p-dev-target-workflow-contract:v(\d+)\s*$/m,
  );
  if (!markerMatch) {
    return null;
  }

  const contractVersion = Number.parseInt(markerMatch[1] ?? "", 10);
  if (!Number.isFinite(contractVersion)) {
    return null;
  }

  const harnessDispatchRepo =
    content.match(/^#\s*harness_dispatch_repo:\s*(\S+)\s*$/m)?.[1] ??
    extractDispatchRepoFromCurl(content);
  const repoConfigId =
    content.match(/^#\s*repo_config_id:\s*(\S+)\s*$/m)?.[1] ?? "";
  const productionBranch =
    content.match(/^#\s*production_branch:\s*(\S+)\s*$/m)?.[1] ??
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

function parseHtmlContractComment(
  content: string,
): TargetWorkflowContractFields | null {
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

/**
 * Parse contract metadata from a target workflow file.
 * Prefers YAML `#` markers (v3+); still parses invalid HTML v2 markers for upgrade detection.
 */
export function parseTargetWorkflowContract(
  content: string | null | undefined,
): TargetWorkflowContractFields | null {
  if (!content) {
    return null;
  }

  return parseYamlContractComment(content) ?? parseHtmlContractComment(content);
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

  const intendedVersion =
    input.intendedContractVersion ?? TARGET_WORKFLOW_CONTRACT_VERSION;

  // Invalid HTML-prefixed workflows always need upgrade (broken GHA YAML).
  if (hasInvalidHtmlContractMarker(input.existingContent)) {
    return "contract_outdated";
  }

  const existingContract = parseTargetWorkflowContract(input.existingContent);

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
