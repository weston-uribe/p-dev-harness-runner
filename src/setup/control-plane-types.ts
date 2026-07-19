export interface LinearWorkspaceSelection {
  teamMode: "existing" | "create";
  teamId?: string;
  teamKey: string;
  teamName: string;
  projectMode: "existing" | "create";
  projectId?: string;
  projectName: string;
  statusCoverageComplete: boolean;
  appliedFingerprint?: string;
  appliedAt?: string;
  manualComplete?: boolean;
}

export type LinearTeamHealth =
  | "healthy"
  | "needs_repair"
  | "verification_pending"
  | "unavailable";

export type LinearProjectHealth = LinearTeamHealth;

export interface LinearProjectEvidence {
  projectId: string;
  projectName: string;
  targetRepo?: string;
  lastVerifiedAt?: string;
  health: LinearProjectHealth;
}

export interface LinearTeamEvidence {
  teamId: string;
  teamKey: string;
  teamName: string;
  projects: LinearProjectEvidence[];
  lastVerifiedAt?: string;
  health: LinearTeamHealth;
}

export interface LinearWorkspaceEvidence {
  workspaceId: string;
  workspaceName: string;
  teams: LinearTeamEvidence[];
  appliedFingerprint?: string;
  appliedAt?: string;
  migratedFromVersion?: "singular-linear-selection";
  migratedAt?: string;
}

export interface VercelSignedProbeEvidence {
  passed: boolean;
  statusCode?: number;
  result:
    | "accepted_ignored"
    | "auth_failed"
    | "unreachable"
    | "protection_redirect"
    | "error";
  reason?: string;
  probedAt: string;
  webhookHost?: string;
  webhookPath?: string;
}

export type VercelBridgeRedeployVerificationStatus =
  | "triggered"
  | "building"
  | "ready"
  | "failed"
  | "timeout"
  | "no_source_deployment"
  | "verify_failed"
  | "verified";

export type VercelBridgeOrchestrationPhase =
  | "triggered"
  | "building"
  | "waiting_for_ready"
  | "verifying"
  | "retry_wait"
  | "verified"
  | "terminal";

export type VercelBridgeVerificationFailureClass = "retryable" | "terminal";

export interface VercelBridgeVerificationClaim {
  attemptNumber: number;
  claimId: string;
  claimedAt: string;
}

export type VercelBridgeCandidateSecretSource =
  | "operator"
  | "reused-readable"
  | "generated"
  | "unreadable";

/** Non-secret/tokenized inputs used to compute the preview fingerprint hash. */
export interface VercelBridgePreviewFingerprintInputs {
  actionId: string;
  teamId?: string;
  teamMode?: string;
  teamSlug?: string;
  projectId: string;
  projectMode?: string;
  projectName?: string;
  envWritePlan: Array<{
    key: string;
    action: string;
    source: string;
    existingType?: string;
    desiredType?: string;
  }>;
  linearWebhookSecretToken: string;
  githubDispatchTokenToken: string;
  harnessTeamKey: string;
  vercelTokenToken: string;
  allowExistingProjectBridgeInstall?: boolean;
}

export interface VercelBridgeRedeployVerification {
  actionId: string;
  projectId: string;
  projectName: string;
  teamId?: string;
  webhookUrl: string;
  fingerprint: string;
  fingerprintInputs?: VercelBridgePreviewFingerprintInputs;
  candidateSecretSource?: VercelBridgeCandidateSecretSource;
  sourceDeploymentId?: string;
  newDeploymentId?: string;
  status: VercelBridgeRedeployVerificationStatus;
  startedAt: string;
  updatedAt: string;
  deadlineAt: string;
  verifyAttempted?: boolean;
  phase?: VercelBridgeOrchestrationPhase;
  verificationAttemptCount?: number;
  maxVerificationAttempts?: number;
  verificationClaim?: VercelBridgeVerificationClaim;
  lastVerificationAttemptAt?: string;
  nextVerificationAttemptAt?: string;
  lastVerificationFailureReason?: string;
  lastVerificationFailureClass?: VercelBridgeVerificationFailureClass;
  completedAt?: string;
  message?: string;
  blockedMessage?: string;
  blockedNextSteps?: string[];
  writtenEnvKeys?: string[];
  skippedEnvKeys?: string[];
}

export interface VercelBridgeSelection {
  teamId?: string;
  teamName?: string;
  projectId: string;
  projectName: string;
  productionUrl: string;
  webhookUrl: string;
  endpointReachable: boolean;
  envVarPresence: Record<string, "present" | "missing" | "unknown">;
  linearWebhookVerified: boolean;
  signedProbeVerified?: boolean;
  signedProbe?: VercelSignedProbeEvidence;
  verificationFingerprint?: string;
  deploymentRedeployRequired?: boolean;
  appliedFingerprint?: string;
  appliedAt?: string;
  /** Set when control-plane vercel was restored from an existing verified deployment. */
  reconciledFromExistingDeployment?: boolean;
  manualComplete?: boolean;
  redeployVerification?: VercelBridgeRedeployVerification;
}

export interface ControlPlaneSetupState {
  version: 1;
  /** @deprecated Read-only migration input. New writes use linearWorkspace. */
  linear?: LinearWorkspaceSelection;
  linearWorkspace?: LinearWorkspaceEvidence;
  vercel?: VercelBridgeSelection;
  workflowModels?: {
    configFingerprint: string;
    harnessRepository: string;
    syncedAt: string;
  };
  /** Bounded evidence from optional review status provisioning (no secrets). */
  optionalReviewProvisioning?: {
    allTeamsReady: boolean;
    conflict: boolean;
    partial: boolean;
    retryable: boolean;
    message: string;
    recordedAt: string;
    teams: Array<{
      teamId: string;
      status: string;
      created: string[];
      verifiedStatuses?: Array<{ name: string; id: string; category: string }>;
      error?: string;
    }>;
  };
  runnerUpgrade?: {
    appliedSnapshotContentId?: string;
    appliedAt?: string;
    targetSnapshotContentId?: string;
    repositoryId?: number;
    lastOperationId?: string;
    syncInProgress?: boolean;
    status?:
      | "up_to_date"
      | "update_available"
      | "checking"
      | "updating"
      | "partially_updated"
      | "failed"
      | "blocked_non_managed"
      | "blocked_unexpected_remote"
      | "blocked_operator_conflicts";
    canaryRunUrl?: string;
  };
  initialSetup?: {
    status: "complete";
    completedAt: string;
    completedByVersion?: string;
    completionEvidence: {
      localConfigPresent: true;
      linearConfigured: true;
      vercelConfigured: true;
      cloudSecretsVerified: true;
      targetWorkflowsVerified: true;
    };
  };
}

export interface ControlPlaneReadinessContext {
  state: ControlPlaneSetupState | null;
  linearTeamKeyFromConfig?: string;
}
