import type { SetupPermission, SetupPermissionScope } from "./permission-model.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";

export const HARNESS_ACTIONS_SECRET_NAMES = [
  "HARNESS_CONFIG_JSON_B64",
  "LINEAR_API_KEY",
  "CURSOR_API_KEY",
  "HARNESS_GITHUB_TOKEN",
] as const;

export type HarnessActionsSecretName =
  (typeof HARNESS_ACTIONS_SECRET_NAMES)[number];

export const MANUAL_HARNESS_DISPATCH_REPO_PLACEHOLDER =
  "<harness-dispatch-repo>";

export function evaluateHarnessSecretPresence(
  statuses: HarnessSecretStatusEntry[],
): {
  allPresent: boolean;
  missing: HarnessActionsSecretName[];
  unknown: HarnessActionsSecretName[];
} {
  const statusByName = new Map(statuses.map((entry) => [entry.name, entry.status]));
  const missing: HarnessActionsSecretName[] = [];
  const unknown: HarnessActionsSecretName[] = [];

  for (const name of HARNESS_ACTIONS_SECRET_NAMES) {
    const status = statusByName.get(name);
    if (status === "present") {
      continue;
    }
    if (status === "unknown") {
      unknown.push(name);
      continue;
    }
    missing.push(name);
  }

  return {
    allPresent: missing.length === 0 && unknown.length === 0,
    missing,
    unknown,
  };
}

export const TARGET_WORKFLOW_PATH =
  ".github/workflows/trigger-harness-production-sync.yml";

export type RemoteSetupStatus = "present" | "missing" | "unknown";

export type RemoteWorkflowStatus =
  | "present"
  | "missing"
  | "differs"
  | "stale_dispatch_target"
  | "contract_outdated"
  | "unknown";

export type RemoteAccessStatus = "available" | "denied" | "unknown";

export interface RemoteSetupActionDescriptor {
  id: string;
  label: string;
  description: string;
  permission: SetupPermission;
}

export const REMOTE_SETUP_ACTIONS = {
  previewHarnessSecrets: {
    id: "preview-harness-secrets",
    label: "Preview harness repo Actions secrets",
    description:
      "Dry-run preview of harness repo GitHub Actions secret writes after confirmation",
    permission: SETUP_PERMISSIONS.remoteRead,
  },
  applyHarnessSecrets: {
    id: "apply-harness-secrets",
    label: "Apply harness repo Actions secrets",
    description:
      "Write harness repo GitHub Actions secrets after explicit confirmation",
    permission: SETUP_PERMISSIONS.remoteSecretWrite,
  },
  previewTargetWorkflowPr: {
    id: "preview-target-workflow-pr",
    label: "Preview target repo workflow PR",
    description:
      "Dry-run preview of target repo production sync workflow branch and PR install",
    permission: SETUP_PERMISSIONS.remoteRead,
  },
  applyTargetWorkflowPr: {
    id: "apply-target-workflow-pr",
    label: "Apply target repo workflow PR",
    description:
      "Create or update a target repo branch and PR for the production sync workflow",
    permission: SETUP_PERMISSIONS.remoteRepoWrite,
  },
} as const satisfies Record<string, RemoteSetupActionDescriptor>;

export interface HarnessSecretStatusEntry {
  name: HarnessActionsSecretName;
  status: RemoteSetupStatus;
}

export interface HarnessSecretWritePlanEntry {
  name: HarnessActionsSecretName;
  action: "create" | "update" | "skip";
  source:
    | "generated-config-b64"
    | "operator-input"
    | "preserve-existing"
    | "missing-input";
}

export interface RemoteHarnessSecretPreview {
  actionId: string;
  harnessDispatchRepo: string;
  harnessDispatchRepoResolved: boolean;
  harnessDispatchRepoSource: string;
  repoAccess: RemoteAccessStatus;
  secretStatuses: HarnessSecretStatusEntry[];
  secretWritePlan: HarnessSecretWritePlanEntry[];
  secretKeyNames: HarnessActionsSecretName[];
  fingerprint: string;
  permission: SetupPermission;
  manualInstructions: string[];
  validationError?: string;
}

export interface TargetWorkflowPrPlan {
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
}

export interface RemoteTargetWorkflowPreview {
  actionId: string;
  plan: TargetWorkflowPrPlan;
  repoAccess: RemoteAccessStatus;
  workflowPreviewSummary: string;
  fingerprint: string;
  permission: SetupPermission;
  manualInstructions: string[];
  validationError?: string;
}

export interface RemoteHarnessSecretApplyResult {
  actionId: string;
  harnessDispatchRepo: string;
  writtenSecrets: Array<{
    name: HarnessActionsSecretName;
    status: "created" | "updated";
  }>;
  skippedSecretNames: HarnessActionsSecretName[];
  fingerprint: string;
  permission: SetupPermission;
}

export interface RemoteHarnessSecretManualCopyValues {
  values: Partial<Record<HarnessActionsSecretName, string>>;
  missing: HarnessActionsSecretName[];
}

export interface RemoteTargetWorkflowApplyResult {
  actionId: string;
  harnessDispatchRepo: string;
  repoConfigId: string;
  outcome:
    | "already-installed"
    | "pr-created"
    | "pr-updated"
    | "branch-updated";
  branchName: string;
  prUrl?: string;
  directProductionBranchWrite: false;
  fingerprint: string;
  permission: SetupPermission;
}

export function assertRemoteSetupPermissionScope(
  actual: SetupPermissionScope,
  expected: SetupPermissionScope,
): void {
  if (actual !== expected) {
    throw new Error(
      `Remote setup action requires permission scope "${expected}", received "${actual}"`,
    );
  }
}

export function assertRemoteSetupConfirmed(confirmed: boolean): void {
  if (!confirmed) {
    throw new Error("Remote setup writes require explicit confirmation");
  }
}

export function assertRemoteSetupFingerprint(
  provided: string,
  expected: string,
): void {
  if (!provided) {
    throw new Error("Preview fingerprint is required");
  }
  if (provided !== expected) {
    throw new Error(
      "Preview fingerprint is stale. Regenerate preview before applying.",
    );
  }
}
