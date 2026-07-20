import { access, readFile } from "node:fs/promises";
import { harnessConfigSchema } from "../config/schema.js";
import type { HarnessConfig } from "../config/types.js";
import {
  evidenceFromAssociations,
  resolveLinearAssociationsFromConfig,
} from "../config/resolve-linear-workspace.js";
import type { ControlPlaneSetupState } from "./control-plane-types.js";
import {
  readControlPlaneSetupState,
  updateControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import type { RemoteSetupSummary } from "./remote-setup-summary.js";
import type { SetupGuiViewModel } from "./gui-view-model.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import { HARNESS_ACTIONS_SECRET_NAMES } from "./remote-actions.js";
import {
  reconcileVercelControlPlaneFromRemote,
  type VercelBridgeReconcileResult,
} from "./vercel-bridge-reconcile.js";
import { isNonAuthoritativeLinearWorkspaceName } from "./linear-workspace-identity.js";

export type InitialSetupCompletionEvidence = {
  localConfigPresent: boolean;
  linearConfigured: boolean;
  vercelConfigured: boolean;
  cloudSecretsVerified: boolean;
  targetWorkflowsVerified: boolean;
};

export type InitialSetupEvidenceField = keyof InitialSetupCompletionEvidence;

export type InitialSetupEvidenceReasonCode =
  | "local_config_incomplete"
  | "linear_control_plane_missing"
  | "vercel_project_missing"
  | "vercel_token_missing"
  | "vercel_bridge_not_found"
  | "vercel_bridge_ambiguous"
  | "vercel_bridge_unhealthy"
  | "cloud_secrets_unverified"
  | "target_workflows_unverified";

export type InitialSetupEvidenceReason = {
  field: InitialSetupEvidenceField;
  code: InitialSetupEvidenceReasonCode;
  message: string;
  details?: {
    missingSecretNames?: string[];
    unknownSecretNames?: string[];
    unverifiedRepoConfigIds?: string[];
  };
};

export type InitialSetupReconciliationResult = {
  ok: boolean;
  state: ControlPlaneSetupState | null;
  evidence: InitialSetupCompletionEvidence;
  reasons: InitialSetupEvidenceReason[];
  wroteMarker: boolean;
};

export function isInitialSetupComplete(
  state: ControlPlaneSetupState | null | undefined,
): boolean {
  return state?.initialSetup?.status === "complete";
}

function controlPlaneLinearConfigured(
  controlPlane: ControlPlaneSetupState | null,
): boolean {
  return Boolean(
    controlPlane?.linearWorkspace?.teams.some(
      (team) => team.projects.length > 0,
    ) ||
      (controlPlane?.linear?.teamId?.trim() &&
        controlPlane.linear.teamKey?.trim()),
  );
}

export function assessCompletionEvidence(input: {
  setupSummary: SetupGuiViewModel;
  remoteSummary: RemoteSetupSummary;
  controlPlane: ControlPlaneSetupState | null;
}): InitialSetupCompletionEvidence {
  const { setupSummary, remoteSummary, controlPlane } = input;

  const localConfigPresent =
    setupSummary.overview.configResolved &&
    setupSummary.overview.localFilesPresent &&
    setupSummary.overview.readyForLocalDoctor;

  const linearConfigured = controlPlaneLinearConfigured(controlPlane);

  const vercelConfigured = Boolean(controlPlane?.vercel?.projectId?.trim());

  const cloudSecretsVerified =
    remoteSummary.harnessSecretStatuses.length > 0 &&
    HARNESS_ACTIONS_SECRET_NAMES.every((name) =>
      remoteSummary.harnessSecretStatuses.some(
        (entry) => entry.name === name && entry.status === "present",
      ),
    );

  const targetWorkflowsVerified =
    remoteSummary.targetRepos.length > 0 &&
    remoteSummary.targetRepos.every(
      (repo) => repo.workflowStatus === "present",
    );

  return {
    localConfigPresent,
    linearConfigured,
    vercelConfigured,
    cloudSecretsVerified,
    targetWorkflowsVerified,
  };
}

export function isCompletionEvidenceSatisfied(
  evidence: InitialSetupCompletionEvidence,
): evidence is {
  localConfigPresent: true;
  linearConfigured: true;
  vercelConfigured: true;
  cloudSecretsVerified: true;
  targetWorkflowsVerified: true;
} {
  return (
    evidence.localConfigPresent &&
    evidence.linearConfigured &&
    evidence.vercelConfigured &&
    evidence.cloudSecretsVerified &&
    evidence.targetWorkflowsVerified
  );
}

function vercelReasonFromReconcile(
  vercelReconcile?: VercelBridgeReconcileResult,
): InitialSetupEvidenceReason {
  switch (vercelReconcile?.status) {
    case "token_missing":
      return {
        field: "vercelConfigured",
        code: "vercel_token_missing",
        message: vercelReconcile.message,
      };
    case "not_found":
      return {
        field: "vercelConfigured",
        code: "vercel_bridge_not_found",
        message: vercelReconcile.message,
      };
    case "ambiguous":
      return {
        field: "vercelConfigured",
        code: "vercel_bridge_ambiguous",
        message: vercelReconcile.message,
      };
    case "unhealthy":
    case "verification_failed":
      return {
        field: "vercelConfigured",
        code: "vercel_bridge_unhealthy",
        message: vercelReconcile.message,
      };
    default:
      return {
        field: "vercelConfigured",
        code: "vercel_project_missing",
        message:
          "Vercel bridge project is not recorded in control-plane setup state. Complete the Vercel bridge step so a projectId is persisted.",
      };
  }
}

export function buildCompletionEvidenceReasons(input: {
  evidence: InitialSetupCompletionEvidence;
  remoteSummary: RemoteSetupSummary;
  vercelReconcile?: VercelBridgeReconcileResult;
}): InitialSetupEvidenceReason[] {
  const { evidence, remoteSummary } = input;
  const reasons: InitialSetupEvidenceReason[] = [];

  if (!evidence.localConfigPresent) {
    reasons.push({
      field: "localConfigPresent",
      code: "local_config_incomplete",
      message:
        "Local harness config is incomplete. Ensure .env.local and .harness/config.local.json are present and resolve.",
    });
  }

  if (!evidence.linearConfigured) {
    reasons.push({
      field: "linearConfigured",
      code: "linear_control_plane_missing",
      message:
        "Linear workspace is not recorded in control-plane setup state. Complete Linear workspace setup or ensure committed linearAssociations can be reconciled.",
    });
  }

  if (!evidence.vercelConfigured) {
    reasons.push(vercelReasonFromReconcile(input.vercelReconcile));
  }

  if (!evidence.cloudSecretsVerified) {
    const missingSecretNames = HARNESS_ACTIONS_SECRET_NAMES.filter(
      (name) =>
        !remoteSummary.harnessSecretStatuses.some(
          (entry) => entry.name === name && entry.status === "present",
        ),
    );
    const unknownSecretNames = remoteSummary.harnessSecretStatuses
      .filter((entry) => entry.status === "unknown")
      .map((entry) => entry.name);
    reasons.push({
      field: "cloudSecretsVerified",
      code: "cloud_secrets_unverified",
      message:
        "Required GitHub Actions harness secrets are missing or unverified on the harness dispatch repository.",
      details: { missingSecretNames, unknownSecretNames },
    });
  }

  if (!evidence.targetWorkflowsVerified) {
    const unverifiedRepoConfigIds = remoteSummary.targetRepos
      .filter((repo) => repo.workflowStatus !== "present")
      .map((repo) => repo.repoConfigId);
    reasons.push({
      field: "targetWorkflowsVerified",
      code: "target_workflows_unverified",
      message:
        "One or more target repositories do not have the harness workflow present.",
      details: {
        unverifiedRepoConfigIds:
          unverifiedRepoConfigIds.length > 0
            ? unverifiedRepoConfigIds
            : remoteSummary.targetRepos.length === 0
              ? ["(no target repos)"]
              : unverifiedRepoConfigIds,
      },
    });
  }

  return reasons;
}

export function formatCompletionEvidenceFailureMessage(
  reasons: InitialSetupEvidenceReason[],
): string {
  if (reasons.length === 0) {
    return "Initial setup completion evidence is not satisfied.";
  }
  const summary = reasons
    .map((reason) => `${reason.field} (${reason.code})`)
    .join(", ");
  return `Initial setup completion evidence is not satisfied: ${summary}.`;
}

export async function writeInitialSetupComplete(
  cwd: string | undefined,
  evidence: {
    localConfigPresent: true;
    linearConfigured: true;
    vercelConfigured: true;
    cloudSecretsVerified: true;
    targetWorkflowsVerified: true;
  },
  completedByVersion?: string,
): Promise<ControlPlaneSetupState> {
  return updateControlPlaneSetupState(
    {
      initialSetup: {
        status: "complete",
        completedAt: new Date().toISOString(),
        completedByVersion,
        completionEvidence: evidence,
      },
    },
    cwd,
  );
}

async function readHarnessConfigLocal(
  cwd?: string,
): Promise<HarnessConfig | null> {
  const paths = resolveLocalFilePaths(cwd);
  try {
    await access(paths.configLocal);
    const raw = await readFile(paths.configLocal, "utf8");
    return harnessConfigSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Persist control-plane Linear evidence from authoritative config associations
 * when control-plane Linear metadata is missing.
 */
export async function reconcileLinearControlPlaneFromConfig(
  cwd?: string,
  existing: ControlPlaneSetupState | null = null,
): Promise<ControlPlaneSetupState | null> {
  const controlPlane = existing ?? (await readControlPlaneSetupState(cwd));
  if (controlPlaneLinearConfigured(controlPlane)) {
    return controlPlane;
  }

  const config = await readHarnessConfigLocal(cwd);
  if (!config) {
    return controlPlane;
  }

  const associations = resolveLinearAssociationsFromConfig(config);
  if (associations.length === 0) {
    return controlPlane;
  }

  const workspaceIds = [
    ...new Set(associations.map((association) => association.workspaceId)),
  ];
  if (workspaceIds.length !== 1) {
    return controlPlane;
  }

  const workspaceId = workspaceIds[0]!;
  const existingName = controlPlane?.linearWorkspace?.workspaceName?.trim() ?? "";
  const evidence = evidenceFromAssociations({
    workspaceId,
    // Never persist a generic placeholder as durable identity.
    workspaceName: isNonAuthoritativeLinearWorkspaceName(existingName)
      ? ""
      : existingName,
    associations,
    appliedAt: new Date().toISOString(),
  });

  return updateControlPlaneSetupState({ linearWorkspace: evidence }, cwd);
}

/**
 * Canonical initial-setup reconciliation:
 * load evidence, backfill Linear control-plane metadata from config when needed,
 * return five booleans + reason codes, and write the durable marker only when
 * all required evidence is satisfied.
 */
export async function reconcileInitialSetupCompletion(input: {
  cwd?: string;
  setupSummary: SetupGuiViewModel;
  remoteSummary: RemoteSetupSummary;
  completedByVersion?: string;
}): Promise<InitialSetupReconciliationResult> {
  const cwd = input.cwd;
  let controlPlane = await readControlPlaneSetupState(cwd);

  if (isInitialSetupComplete(controlPlane)) {
    return {
      ok: true,
      state: controlPlane,
      evidence: controlPlane!.initialSetup!.completionEvidence,
      reasons: [],
      wroteMarker: false,
    };
  }

  controlPlane = await reconcileLinearControlPlaneFromConfig(cwd, controlPlane);
  const vercelReconcile = await reconcileVercelControlPlaneFromRemote({
    cwd,
    controlPlane,
  });
  controlPlane = vercelReconcile.state;

  const evidence = assessCompletionEvidence({
    setupSummary: input.setupSummary,
    remoteSummary: input.remoteSummary,
    controlPlane,
  });
  const reasons = buildCompletionEvidenceReasons({
    evidence,
    remoteSummary: input.remoteSummary,
    vercelReconcile,
  });

  if (!isCompletionEvidenceSatisfied(evidence)) {
    return {
      ok: false,
      state: controlPlane,
      evidence,
      reasons,
      wroteMarker: false,
    };
  }

  const state = await writeInitialSetupComplete(
    cwd,
    evidence,
    input.completedByVersion,
  );
  return {
    ok: true,
    state,
    evidence,
    reasons: [],
    wroteMarker: true,
  };
}

export async function migrateExistingCompletedWorkspace(input: {
  cwd?: string;
  setupSummary: SetupGuiViewModel;
  remoteSummary: RemoteSetupSummary;
}): Promise<ControlPlaneSetupState | null> {
  const result = await reconcileInitialSetupCompletion({
    cwd: input.cwd,
    setupSummary: input.setupSummary,
    remoteSummary: input.remoteSummary,
    completedByVersion: "v0.4-configure-migration",
  });
  return result.state;
}

export async function completeInitialSetupFromServer(input: {
  cwd?: string;
  setupSummary: SetupGuiViewModel;
  remoteSummary: RemoteSetupSummary;
}): Promise<
  | { ok: true; state: ControlPlaneSetupState; wroteMarker: boolean }
  | {
      ok: false;
      evidence: InitialSetupCompletionEvidence;
      reasons: InitialSetupEvidenceReason[];
    }
> {
  const result = await reconcileInitialSetupCompletion(input);
  if (!result.ok || !result.state) {
    return {
      ok: false,
      evidence: result.evidence,
      reasons: result.reasons,
    };
  }
  return {
    ok: true,
    state: result.state,
    wroteMarker: result.wroteMarker,
  };
}

export async function readInitialSetupRoutingState(cwd?: string): Promise<{
  complete: boolean;
  state: ControlPlaneSetupState | null;
}> {
  const paths = resolveLocalFilePaths(cwd);
  try {
    await access(paths.harnessDir);
  } catch {
    return { complete: false, state: null };
  }

  const state = await readControlPlaneSetupState(cwd);
  return {
    complete: isInitialSetupComplete(state),
    state,
  };
}
