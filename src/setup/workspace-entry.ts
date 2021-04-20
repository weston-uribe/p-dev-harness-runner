import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  readControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import type { ControlPlaneSetupState } from "./control-plane-types.js";
import { isInitialSetupComplete } from "./initial-setup-lifecycle.js";
import {
  CONFIGURE_ROUTE,
  CONNECTIONS_VERCEL_REPAIR_ROUTE,
  WORKFLOW_ROUTE,
} from "./gui-routes.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import type {
  PDevBridgeHealthStatus,
  WorkspaceMaturity,
} from "./workspace-health.js";

export type WorkspaceEntryRoute =
  | typeof CONFIGURE_ROUTE
  | typeof WORKFLOW_ROUTE
  | typeof CONNECTIONS_VERCEL_REPAIR_ROUTE;

export type WorkspaceEntryDecision = {
  maturity: WorkspaceMaturity;
  route: WorkspaceEntryRoute;
  repair?: "vercel";
  /** Bridge health from durable local evidence only — never live Vercel API. */
  bridgeHealth: PDevBridgeHealthStatus;
  evidence: string[];
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasResolvedLocalHarnessConfig(cwd?: string): Promise<boolean> {
  const paths = resolveLocalFilePaths(cwd);
  if (!(await pathExists(paths.configLocal))) {
    return false;
  }
  try {
    const raw = await readFile(paths.configLocal, "utf8");
    const parsed = JSON.parse(raw) as {
      repos?: unknown[];
      allowedTargetRepos?: unknown[];
    };
    const repos = Array.isArray(parsed.repos) ? parsed.repos : [];
    return repos.length > 0;
  } catch {
    return false;
  }
}

function hasLinearEvidence(state: ControlPlaneSetupState | null): boolean {
  if (!state) {
    return false;
  }
  if (state.linearWorkspace?.teams?.length) {
    return true;
  }
  if (state.linear?.teamKey?.trim() || state.linear?.teamId?.trim()) {
    return true;
  }
  return false;
}

function hasCloudSecretsEvidence(state: ControlPlaneSetupState | null): boolean {
  return Boolean(state?.initialSetup?.completionEvidence?.cloudSecretsVerified);
}

function hasTargetWorkflowEvidence(state: ControlPlaneSetupState | null): boolean {
  return Boolean(
    state?.initialSetup?.completionEvidence?.targetWorkflowsVerified,
  );
}

function hasManagedRunnerEvidence(state: ControlPlaneSetupState | null): boolean {
  const runner = state?.runnerUpgrade;
  if (!runner) {
    return false;
  }
  return Boolean(
    runner.appliedSnapshotContentId?.trim() ||
      runner.repositoryId ||
      runner.status === "up_to_date" ||
      runner.status === "update_available" ||
      runner.status === "partially_updated",
  );
}

function hasPriorVercelMetadata(state: ControlPlaneSetupState | null): boolean {
  return Boolean(state?.vercel?.projectId?.trim());
}

/**
 * Durable bridge health from control-plane evidence only.
 * Does not call Vercel APIs.
 */
export function assessDurableBridgeHealth(
  state: ControlPlaneSetupState | null,
): PDevBridgeHealthStatus {
  // Prior successful initial-setup completion is durable operational evidence
  // that the bridge was verified; revoked tokens / missing local Vercel metadata
  // must not force repair routing away from Workflow.
  if (
    state?.initialSetup?.status === "complete" &&
    state.initialSetup.completionEvidence.vercelConfigured
  ) {
    return "verified";
  }

  const vercel = state?.vercel;
  if (!vercel?.projectId?.trim()) {
    return "missing";
  }

  const probeVerified =
    vercel.signedProbeVerified === true &&
    vercel.linearWebhookVerified === true &&
    vercel.endpointReachable === true &&
    !vercel.deploymentRedeployRequired;

  // Verified probe evidence wins over a stale in-progress redeploy record.
  if (probeVerified) {
    return "verified";
  }

  const redeploy = vercel.redeployVerification;
  if (
    redeploy &&
    ["triggered", "building", "ready"].includes(redeploy.status) &&
    redeploy.phase !== "verified" &&
    redeploy.phase !== "terminal"
  ) {
    return "deploying";
  }

  return "unhealthy";
}

export async function collectEstablishedEvidence(
  cwd?: string,
): Promise<{ established: boolean; evidence: string[] }> {
  const evidence: string[] = [];
  const paths = resolveLocalFilePaths(cwd);

  try {
    await access(paths.harnessDir);
  } catch {
    return { established: false, evidence };
  }

  const state = await readControlPlaneSetupState(cwd);

  if (await hasResolvedLocalHarnessConfig(cwd)) {
    evidence.push("local-harness-config");
  }
  if (hasLinearEvidence(state)) {
    evidence.push("linear-workspace");
  }
  if (hasCloudSecretsEvidence(state)) {
    evidence.push("cloud-secrets-verified");
  }
  if (hasTargetWorkflowEvidence(state)) {
    evidence.push("target-workflows-verified");
  }
  if (hasManagedRunnerEvidence(state)) {
    evidence.push("managed-runner");
  }
  if (hasPriorVercelMetadata(state)) {
    evidence.push("control-plane-vercel");
  }
  if (isInitialSetupComplete(state)) {
    evidence.push("initial-setup-complete");
  }

  // Target workflow install marker under .harness (optional durable signal)
  const workflowMarker = path.join(paths.harnessDir, "target-workflow-install.json");
  if (await pathExists(workflowMarker)) {
    evidence.push("target-workflow-install");
  }

  return { established: evidence.length > 0, evidence };
}

/**
 * Classify workspace entry using local durable evidence only.
 * Must not perform live Vercel (or other remote) API requests.
 */
export async function classifyWorkspaceEntry(
  cwd?: string,
): Promise<WorkspaceEntryDecision> {
  const { established, evidence } = await collectEstablishedEvidence(cwd);
  const state = established ? await readControlPlaneSetupState(cwd) : null;
  const bridgeHealth = assessDurableBridgeHealth(state);

  if (!established) {
    return {
      maturity: "new",
      route: CONFIGURE_ROUTE,
      bridgeHealth: "missing",
      evidence,
    };
  }

  // Established + missing/unhealthy durable bridge → Connections repair.
  // Do NOT route on saved-but-unverified token presence.
  if (bridgeHealth === "missing" || bridgeHealth === "unhealthy") {
    return {
      maturity: "established",
      route: CONNECTIONS_VERCEL_REPAIR_ROUTE,
      repair: "vercel",
      bridgeHealth,
      evidence,
    };
  }

  // Verified (or deploying with project identity) bridge → Workflow.
  // Revoked tokens are handled as a Connections warning after Workflow loads,
  // not as root-route repair.
  return {
    maturity: "established",
    route: WORKFLOW_ROUTE,
    bridgeHealth,
    evidence,
  };
}
