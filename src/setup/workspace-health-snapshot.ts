/**
 * Canonical workspace health snapshot shared by Workflow and Settings pages.
 * Facts stay granular — historical initialSetup.complete never implies current probes.
 */

import { createHash } from "node:crypto";
import type { ControlPlaneSetupState } from "./control-plane-types.js";
import { summarizeLinearWorkspaceStatus } from "./control-plane-readiness.js";
import { readControlPlaneSetupState } from "./control-plane-setup-state.js";
import {
  initialCredentialHealthFromPresence,
  type SavedCredentialHealth,
} from "./credential-health.js";
import { readExistingEnvFile } from "./env-merge.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import {
  assessDurableBridgeHealth,
} from "./workspace-entry.js";
import type {
  CredentialHealthStatus,
  HealthAggregateStatus,
  PDevBridgeHealthStatus,
} from "./workspace-health.js";
import { isCredentialFailureStatus } from "./workspace-health.js";
import { isNonAuthoritativeLinearWorkspaceName } from "./linear-workspace-identity.js";

export type CredentialHealthFact = {
  present: boolean;
  status: CredentialHealthStatus;
  aggregate: HealthAggregateStatus;
  accountLabel?: string;
  message?: string;
  limitation?: string;
  checkedAt?: string;
};

export type VercelScopeFact = {
  teamId?: string;
  teamName: string;
  source: "control_plane" | "recovery_operation";
};

export type VercelProjectFact = {
  projectId: string;
  projectName: string;
};

export type VercelRecoveryFact = {
  active: boolean;
  aggregate: HealthAggregateStatus;
  failureReason?: string;
  /** false when control plane already has authoritative scope in use */
  promptScopeSelection: boolean;
};

export type VercelHealthFacts = {
  credential: CredentialHealthFact;
  accountIdentity?: string;
  selectedScope?: VercelScopeFact;
  selectedProject?: VercelProjectFact;
  bridgeDeployed: boolean;
  bridgeReachable: boolean;
  webhookConfigured: boolean;
  webhookVerified: boolean;
  signedProbeVerified: boolean;
  productionUrl?: string;
  lastVerifiedAt?: string;
  recovery: VercelRecoveryFact;
  durableBridgeHealth: PDevBridgeHealthStatus;
  historicalSetupComplete: boolean;
  /** Operator-facing automation aggregate for Workflow strip */
  automationAggregate: HealthAggregateStatus;
};

export type LinearTeamProjectFact = {
  teamId: string;
  teamKey: string;
  teamName: string;
  projects: Array<{ projectId: string; projectName: string }>;
  statusConfigPresent: boolean;
};

export type LinearHealthFacts = {
  credential: CredentialHealthFact;
  workspaceName?: string;
  configuredTeams: LinearTeamProjectFact[];
  statusConfigPresent: boolean;
  webhookConfigured: boolean;
  webhookVerified: boolean;
  lastSuccessfulAcceptedEventAt?: string;
  lastVerifiedAt?: string;
  automationAggregate: HealthAggregateStatus;
};

export type WorkspaceHealthSnapshot = {
  generatedAt: string;
  controlPlaneFingerprint: string;
  vercel: VercelHealthFacts;
  linear: LinearHealthFacts;
};

export function credentialHealthToAggregate(
  fact: Pick<CredentialHealthFact, "present" | "status">,
  liveVerified: boolean,
): HealthAggregateStatus {
  if (!fact.present || fact.status === "missing") return "missing";
  if (
    fact.status === "verification_pending" ||
    fact.status === "checking"
  ) {
    return "verification_pending";
  }
  if (fact.status === "connected") {
    return liveVerified ? "verified" : "configured";
  }
  if (isCredentialFailureStatus(fact.status)) return "degraded";
  if (
    fact.status === "provider_unavailable" ||
    fact.status === "bridge_unreachable" ||
    fact.status === "local_runtime_error" ||
    fact.status === "unknown"
  ) {
    return "degraded";
  }
  return "verification_pending";
}

export function computeControlPlaneHealthFingerprint(
  state: ControlPlaneSetupState | null,
): string {
  const material = JSON.stringify({
    vercel: state?.vercel
      ? {
          teamId: state.vercel.teamId ?? null,
          projectId: state.vercel.projectId,
          productionUrl: state.vercel.productionUrl,
          webhookUrl: state.vercel.webhookUrl,
          endpointReachable: state.vercel.endpointReachable,
          linearWebhookVerified: state.vercel.linearWebhookVerified,
          signedProbeVerified: state.vercel.signedProbeVerified ?? false,
          appliedAt: state.vercel.appliedAt ?? null,
        }
      : null,
    linear: state?.linearWorkspace
      ? {
          workspaceName: state.linearWorkspace.workspaceName,
          teams: state.linearWorkspace.teams.map((t) => ({
            teamId: t.teamId,
            health: t.health,
            projects: t.projects.map((p) => ({
              projectId: p.projectId,
              health: p.health,
            })),
          })),
        }
      : null,
    initialSetup: state?.initialSetup?.status ?? null,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function resolveAuthoritativeVercelScope(
  state: ControlPlaneSetupState | null,
): VercelScopeFact | undefined {
  const vercel = state?.vercel;
  if (!vercel?.projectId?.trim()) return undefined;
  const teamName = vercel.teamName?.trim();
  if (!teamName && !vercel.teamId?.trim()) {
    return {
      teamName: "Personal",
      teamId: undefined,
      source: "control_plane",
    };
  }
  return {
    teamId: vercel.teamId,
    teamName: teamName || "Team",
    source: "control_plane",
  };
}

export function shouldPromptRecoveryScopeSelection(input: {
  recoveryNeedsScope: boolean;
  authoritativeScope?: VercelScopeFact;
}): boolean {
  if (!input.recoveryNeedsScope) return false;
  // Already have an authoritative scope in use — do not re-ask.
  if (input.authoritativeScope) return false;
  return true;
}

export function reconcileHistoricalSuccess(input: {
  historicalSetupComplete: boolean;
  currentProbeVerified: boolean;
}): { showDegradedNotVerified: boolean } {
  return {
    showDegradedNotVerified:
      input.historicalSetupComplete && !input.currentProbeVerified,
  };
}

const ATTENTION_STATUS_PRIORITY: Record<HealthAggregateStatus, number> = {
  repairing: 0,
  degraded: 1,
  missing: 2,
  verification_pending: 3,
  configured: 4,
  verified: 5,
};

export type AutomationAttentionSubsystem = "vercel" | "linear";

export type AutomationAttentionFact = {
  subsystem: AutomationAttentionSubsystem;
  status: HealthAggregateStatus;
  detail: string;
};

export type AutomationAttentionState = {
  tone: Exclude<HealthAggregateStatus, "verified">;
  title: string;
  facts: AutomationAttentionFact[];
};

function humanAggregateLabel(status: HealthAggregateStatus): string {
  switch (status) {
    case "missing":
      return "Missing";
    case "configured":
      return "Configured but incomplete";
    case "verification_pending":
      return "Needs verification";
    case "verified":
      return "Verified";
    case "degraded":
      return "Degraded";
    case "repairing":
      return "Repairing";
  }
}

function worseAttentionStatus(
  left: HealthAggregateStatus,
  right: HealthAggregateStatus,
): HealthAggregateStatus {
  return ATTENTION_STATUS_PRIORITY[left] <= ATTENTION_STATUS_PRIORITY[right]
    ? left
    : right;
}

/**
 * Operator-facing automation attention panel state.
 * Returns null when both Linear and Vercel automation aggregates are verified.
 */
export function deriveAutomationAttentionState(
  snapshot: Pick<WorkspaceHealthSnapshot, "vercel" | "linear">,
): AutomationAttentionState | null {
  const { vercel, linear } = snapshot;
  if (
    vercel.automationAggregate === "verified" &&
    linear.automationAggregate === "verified"
  ) {
    return null;
  }

  const facts: AutomationAttentionFact[] = [];

  if (vercel.automationAggregate !== "verified") {
    const bridgeDetail = vercel.bridgeDeployed
      ? vercel.bridgeReachable
        ? "bridge reachable"
        : "bridge not reachable"
      : "bridge not deployed";
    const webhookDetail = vercel.webhookVerified
      ? "webhook verified"
      : vercel.webhookConfigured
        ? "webhook not verified"
        : "webhook not configured";
    facts.push({
      subsystem: "vercel",
      status: vercel.automationAggregate,
      detail: `${humanAggregateLabel(vercel.automationAggregate)} · ${bridgeDetail} · ${webhookDetail}`,
    });
  }

  if (linear.automationAggregate !== "verified") {
    const workspace =
      linear.workspaceName?.trim() || "workspace name unavailable";
    facts.push({
      subsystem: "linear",
      status: linear.automationAggregate,
      detail: `${humanAggregateLabel(linear.automationAggregate)} · ${workspace}`,
    });
  }

  const tone = facts.reduce<HealthAggregateStatus>(
    (current, fact) => worseAttentionStatus(current, fact.status),
    "configured",
  );
  const attentionTone =
    tone === "verified" ? "configured" : (tone as AutomationAttentionState["tone"]);

  const title =
    attentionTone === "repairing"
      ? "Automation needs attention · Repairing"
      : attentionTone === "degraded"
        ? "Automation needs attention · Degraded"
        : attentionTone === "missing"
          ? "Automation needs attention · Missing configuration"
          : attentionTone === "verification_pending"
            ? "Automation needs attention · Needs verification"
            : "Automation needs attention · Incomplete";

  return {
    tone: attentionTone,
    title,
    facts,
  };
}

function toCredentialFact(
  health: SavedCredentialHealth,
  present: boolean,
  liveVerified: boolean,
): CredentialHealthFact {
  return {
    present,
    status: health.status,
    aggregate: credentialHealthToAggregate(
      { present, status: health.status },
      liveVerified,
    ),
    accountLabel: health.label,
    message: health.message,
    limitation: health.limitation,
    checkedAt: health.checkedAt,
  };
}

export function deriveVercelHealthFacts(input: {
  state: ControlPlaneSetupState | null;
  vercelCredential: SavedCredentialHealth;
  vercelPresent: boolean;
  liveCredentialVerified: boolean;
  recoveryActive?: boolean;
  recoveryNeedsScope?: boolean;
  recoveryFailureReason?: string;
}): VercelHealthFacts {
  const vercel = input.state?.vercel;
  const historicalSetupComplete =
    input.state?.initialSetup?.status === "complete" &&
    Boolean(input.state.initialSetup.completionEvidence?.vercelConfigured);

  const webhookVerified = vercel?.linearWebhookVerified === true;
  const signedProbeVerified = vercel?.signedProbeVerified === true;
  const bridgeReachable = vercel?.endpointReachable === true;
  const bridgeDeployed = Boolean(vercel?.projectId?.trim());
  const webhookConfigured = Boolean(vercel?.webhookUrl?.trim());
  const currentProbeVerified =
    webhookVerified && signedProbeVerified && bridgeReachable;

  const durableBridgeHealth = assessDurableBridgeHealth(input.state);
  const credential = toCredentialFact(
    input.vercelCredential,
    input.vercelPresent,
    input.liveCredentialVerified,
  );
  const selectedScope = resolveAuthoritativeVercelScope(input.state);
  const recoveryActive = Boolean(input.recoveryActive);
  const promptScopeSelection = shouldPromptRecoveryScopeSelection({
    recoveryNeedsScope: Boolean(input.recoveryNeedsScope),
    authoritativeScope: selectedScope,
  });

  let automationAggregate: HealthAggregateStatus = "missing";
  if (recoveryActive) {
    automationAggregate = "repairing";
  } else if (!bridgeDeployed) {
    automationAggregate = "missing";
  } else if (currentProbeVerified && credential.aggregate !== "degraded") {
    automationAggregate = "verified";
  } else if (
    reconcileHistoricalSuccess({
      historicalSetupComplete,
      currentProbeVerified,
    }).showDegradedNotVerified ||
    credential.aggregate === "degraded" ||
    durableBridgeHealth === "unhealthy"
  ) {
    automationAggregate = "degraded";
  } else if (durableBridgeHealth === "deploying") {
    automationAggregate = "repairing";
  } else if (bridgeDeployed && !currentProbeVerified) {
    automationAggregate = "verification_pending";
  } else {
    automationAggregate = "configured";
  }

  const lastVerifiedAt =
    vercel?.signedProbe?.probedAt ??
    vercel?.appliedAt ??
    vercel?.redeployVerification?.completedAt;

  return {
    credential,
    accountIdentity: credential.accountLabel,
    selectedScope,
    selectedProject: vercel?.projectId
      ? { projectId: vercel.projectId, projectName: vercel.projectName }
      : undefined,
    bridgeDeployed,
    bridgeReachable,
    webhookConfigured,
    webhookVerified,
    signedProbeVerified,
    productionUrl: vercel?.productionUrl?.trim() || undefined,
    lastVerifiedAt,
    recovery: {
      active: recoveryActive,
      aggregate: recoveryActive
        ? "repairing"
        : currentProbeVerified
          ? "verified"
          : "missing",
      failureReason: input.recoveryFailureReason,
      promptScopeSelection,
    },
    durableBridgeHealth,
    historicalSetupComplete,
    automationAggregate,
  };
}

export function deriveLinearHealthFacts(input: {
  state: ControlPlaneSetupState | null;
  linearCredential: SavedCredentialHealth;
  linearPresent: boolean;
  liveCredentialVerified: boolean;
}): LinearHealthFacts {
  const evidence = input.state?.linearWorkspace;
  const vercel = input.state?.vercel;
  const summary = summarizeLinearWorkspaceStatus({ state: input.state });
  const credential = toCredentialFact(
    input.linearCredential,
    input.linearPresent,
    input.liveCredentialVerified,
  );

  const configuredTeams: LinearTeamProjectFact[] =
    evidence?.teams.map((team) => ({
      teamId: team.teamId,
      teamKey: team.teamKey,
      teamName: team.teamName,
      projects: team.projects.map((p) => ({
        projectId: p.projectId,
        projectName: p.projectName,
      })),
      statusConfigPresent: team.health === "healthy",
    })) ?? [];

  const webhookConfigured = Boolean(vercel?.webhookUrl?.trim());
  const webhookVerified = vercel?.linearWebhookVerified === true;
  const lastVerifiedAt =
    evidence?.appliedAt ??
    vercel?.signedProbe?.probedAt ??
    vercel?.appliedAt;
  const lastSuccessfulAcceptedEventAt =
    vercel?.signedProbe?.passed === true
      ? vercel.signedProbe.probedAt
      : undefined;

  let automationAggregate: HealthAggregateStatus = "missing";
  if (!credential.present) {
    automationAggregate = "missing";
  } else if (credential.aggregate === "degraded") {
    automationAggregate = "degraded";
  } else if (!summary.configured) {
    automationAggregate = "configured";
  } else if (!summary.statusCoverageComplete) {
    automationAggregate = "verification_pending";
  } else if (webhookVerified) {
    automationAggregate = "verified";
  } else if (webhookConfigured) {
    automationAggregate = "verification_pending";
  } else {
    automationAggregate = "configured";
  }

  const rawWorkspaceName = evidence?.workspaceName?.trim() || undefined;
  return {
    credential,
    workspaceName:
      rawWorkspaceName &&
      !isNonAuthoritativeLinearWorkspaceName(rawWorkspaceName)
        ? rawWorkspaceName
        : undefined,
    configuredTeams,
    statusConfigPresent: summary.statusCoverageComplete,
    webhookConfigured,
    webhookVerified,
    lastSuccessfulAcceptedEventAt,
    lastVerifiedAt,
    automationAggregate,
  };
}

export async function buildWorkspaceHealthSnapshot(options?: {
  cwd?: string;
  /** When true, runs live credential verify for Linear + Vercel (slow). Default false. */
  liveCredentials?: boolean;
  recoveryActive?: boolean;
  recoveryNeedsScope?: boolean;
  recoveryFailureReason?: string;
}): Promise<WorkspaceHealthSnapshot> {
  const cwd = options?.cwd;
  const paths = resolveLocalFilePaths(cwd);
  const [state, existingEnv] = await Promise.all([
    readControlPlaneSetupState(cwd),
    readExistingEnvFile(paths),
  ]);

  const vercelPresent = Boolean(existingEnv?.presence.VERCEL_TOKEN);
  const linearPresent = Boolean(existingEnv?.presence.LINEAR_API_KEY);

  let vercelCredential = initialCredentialHealthFromPresence(vercelPresent);
  let linearCredential = initialCredentialHealthFromPresence(linearPresent);
  let liveVerified = false;

  if (options?.liveCredentials) {
    const { verifySavedCredentialHealth } = await import("./credential-health.js");
    const [v, l] = await Promise.all([
      verifySavedCredentialHealth({ cwd, key: "VERCEL_TOKEN" }),
      verifySavedCredentialHealth({ cwd, key: "LINEAR_API_KEY" }),
    ]);
    vercelCredential = v;
    linearCredential = l;
    liveVerified = true;
  }

  const vercel = deriveVercelHealthFacts({
    state,
    vercelCredential,
    vercelPresent,
    liveCredentialVerified: liveVerified && vercelCredential.status === "connected",
    recoveryActive: options?.recoveryActive,
    recoveryNeedsScope: options?.recoveryNeedsScope,
    recoveryFailureReason: options?.recoveryFailureReason,
  });
  const linear = deriveLinearHealthFacts({
    state,
    linearCredential,
    linearPresent,
    liveCredentialVerified: liveVerified && linearCredential.status === "connected",
  });

  return {
    generatedAt: new Date().toISOString(),
    controlPlaneFingerprint: computeControlPlaneHealthFingerprint(state),
    vercel,
    linear,
  };
}

export { shouldAcceptHealthRefresh } from "./workspace-health.js";
