import type { HarnessProvisioningState } from "../setup/harness-repo-provisioning.js";
import type { SnapshotProvisioningErrorCode } from "../setup/harness-snapshot-provisioning-helpers.js";
import type { ErrorCategory, ProvisioningFailureCategory } from "./types.js";

const AUTH_STATES = new Set<HarnessProvisioningState>([
  "token-unavailable",
  "token-invalid",
  "token-unsupported",
  "token-scope-ambiguous",
  "token-insufficient",
]);

const PERMISSION_STATES = new Set<HarnessProvisioningState>([
  "same-name-public-collision",
  "same-name-unmanaged-collision",
  "same-name-malformed-marker",
]);

const SNAPSHOT_STATES = new Set<HarnessProvisioningState>([
  "snapshot-unavailable",
  "snapshot-manifest-missing",
  "snapshot-manifest-invalid",
  "snapshot-incompatible",
  "snapshot-tampered",
  "snapshot-preview-stale",
]);

const LOCAL_PERSISTENCE_STATES = new Set<HarnessProvisioningState>([
  "created-but-persistence-failed",
]);

export function mapHarnessProvisioningStateToErrorCategory(
  state: HarnessProvisioningState,
): ErrorCategory {
  if (AUTH_STATES.has(state)) {
    return "auth";
  }
  if (PERMISSION_STATES.has(state)) {
    return "permission";
  }
  if (SNAPSHOT_STATES.has(state)) {
    return "snapshot_validation";
  }
  if (LOCAL_PERSISTENCE_STATES.has(state)) {
    return "local_persistence";
  }
  if (state.includes("rate-limit")) {
    return "rate_limit";
  }
  if (state.includes("network")) {
    return "network";
  }
  if (state.includes("conflict")) {
    return "conflict";
  }
  return "unknown";
}

export function mapHarnessProvisioningStateToFailureCategory(
  state: HarnessProvisioningState,
): ProvisioningFailureCategory {
  const category = mapHarnessProvisioningStateToErrorCategory(state);
  if (
    category === "validation" ||
    category === "unexpected" ||
    category === "model_selection"
  ) {
    return "unknown";
  }
  return category;
}

export function mapSnapshotProvisioningErrorCode(
  code: SnapshotProvisioningErrorCode,
): ErrorCategory {
  switch (code) {
    case "repository-create-ambiguous":
    case "commit-create-ambiguous":
      return "conflict";
    case "repository-create-reconciliation-failed":
    case "repository-identity-mismatch":
    case "ref-update-unexpected-head":
    case "marker-commit-failed":
    case "description-finalization-failed":
      return "server";
    case "snapshot-tree-mismatch":
      return "snapshot_validation";
    default:
      return "unknown";
  }
}

export function isUserCorrectableProvisioningState(
  state: HarnessProvisioningState,
): boolean {
  return (
    state === "explicit-repo-present" ||
    state === "explicit-packaged-repo-invalid" ||
    state === "explicit-packaged-repo-legacy-source" ||
    state === "snapshot-preview-ready" ||
    state === "repo-absent" ||
    state === "valid-existing-managed-repo" ||
    state === "skipped-not-packaged" ||
    state === "skipped-source-mode"
  );
}

export function shouldCaptureProvisioningStateAsProductError(
  state: HarnessProvisioningState,
): boolean {
  return !isUserCorrectableProvisioningState(state);
}

export function productErrorCodeFromProvisioningState(
  state: HarnessProvisioningState,
): string {
  return `harness_provisioning_${state.replace(/-/g, "_")}`;
}

export function productErrorCodeFromSnapshotCode(
  code: SnapshotProvisioningErrorCode,
): string {
  return `snapshot_provisioning_${code.replace(/-/g, "_")}`;
}

export function mapHttpStatusToErrorCategory(status: number): ErrorCategory {
  if (status === 401 || status === 403) {
    return status === 401 ? "auth" : "permission";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status >= 500) {
    return "server";
  }
  if (status >= 400) {
    return "validation";
  }
  return "unknown";
}
