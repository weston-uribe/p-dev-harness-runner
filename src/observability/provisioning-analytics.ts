import type { HarnessRepoProvisioningPreview } from "../setup/harness-repo-provisioning.js";
import type { HarnessRepoProvisioningApplyResult } from "../setup/harness-repo-provisioning.js";

export function deriveConnectedToExistingManagedWorkspace(input: {
  persisted: boolean;
  previewState: HarnessRepoProvisioningPreview["state"];
}): boolean {
  return (
    input.persisted && input.previewState === "valid-existing-managed-repo"
  );
}

export function deriveCreatedSnapshotBackedWorkspace(input: {
  persisted: boolean;
  applyState: HarnessRepoProvisioningApplyResult["state"];
  preview: Pick<
    HarnessRepoProvisioningPreview,
    "willCreateRepository" | "state"
  >;
}): boolean {
  if (!input.persisted || input.applyState !== "verified-and-persisted") {
    return false;
  }
  return (
    input.preview.willCreateRepository ||
    input.preview.state === "same-name-snapshot-only-with-pending"
  );
}
