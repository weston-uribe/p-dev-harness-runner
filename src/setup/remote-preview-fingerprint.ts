import { createHash } from "node:crypto";
import type { SetupPermissionScope } from "./permission-model.js";

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export interface TargetWorkflowFingerprintInput {
  actionId: string;
  permissionScope: SetupPermissionScope;
  repoConfigId: string;
  targetRepoSlug: string;
  harnessDispatchRepo: string;
  productionBranch: string;
  workflowPath: string;
  branchName: string;
  workflowContentHash: string;
  productionBranchSha?: string;
}

export function computeTargetWorkflowFingerprint(
  input: TargetWorkflowFingerprintInput,
): string {
  const normalized = {
    actionId: input.actionId,
    permissionScope: input.permissionScope,
    repoConfigId: input.repoConfigId,
    targetRepoSlug: input.targetRepoSlug,
    harnessDispatchRepo: input.harnessDispatchRepo,
    productionBranch: input.productionBranch,
    workflowPath: input.workflowPath,
    branchName: input.branchName,
    workflowContentHash: input.workflowContentHash,
    productionBranchSha: input.productionBranchSha ?? "",
  };
  return hashValue(JSON.stringify(normalized));
}
