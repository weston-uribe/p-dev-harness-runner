/** Client-safe recovery types and labels — no Vercel/Cursor SDK imports. */

export type VercelRecoveryStage =
  | "verifying_vercel"
  | "preparing_bridge"
  | "deploying_bridge"
  | "verifying_webhook"
  | "connecting_linear"
  | "ready"
  | "needs_scope"
  | "needs_bridge"
  | "failed";

export type VercelRecoveryNextAction =
  | "enter_different_token"
  | "select_scope"
  | "select_bridge"
  | "retry_deployment"
  | "retry_verification"
  | "retry_linear_connection"
  | "retry_recovery"
  | "none";

export type VercelRecoveryScopeOption = {
  teamId?: string;
  teamName: string;
};

export type VercelRecoveryBridgeCandidate = {
  projectId: string;
  projectName: string;
  teamId?: string;
  teamName?: string;
};

export type VercelRecoveryOperation = {
  operationId: string;
  /** Monotonic revision for optimistic concurrency. */
  revision: number;
  stage: VercelRecoveryStage;
  lastSuccessfulStage?: Exclude<
    VercelRecoveryStage,
    "failed" | "needs_scope" | "needs_bridge"
  >;
  selectedScope?: { teamId?: string; teamName: string };
  selectedBridgeProjectId?: string;
  intendedBridgeProjectName: string;
  projectId?: string;
  deploymentId?: string;
  linearWebhookId?: string;
  failureReason?: string;
  remoteMutationsOccurred: boolean;
  retrySafe: boolean;
  nextAction: VercelRecoveryNextAction;
  humanProblem?: string;
  scopeOptions?: VercelRecoveryScopeOption[];
  bridgeCandidates?: VercelRecoveryBridgeCandidate[];
  pollActionId?: string;
  /** Create vs reuse once discovery finishes. */
  prepareMode?: "create" | "reuse";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  leaseHolder?: string;
  leaseExpiresAt?: string;
};

export type VercelRecoveryPublicStatus = {
  operation: VercelRecoveryOperation | null;
  bridgeHealth: "missing" | "deploying" | "unhealthy" | "verified";
  initialSetupComplete: boolean;
  redirectToWorkflow: boolean;
  conflict?: boolean;
  completionEvidence?: {
    localConfigPresent: true;
    linearConfigured: true;
    vercelConfigured: true;
    cloudSecretsVerified: true;
    targetWorkflowsVerified: true;
  };
};

export function vercelRecoveryStageLabel(stage: VercelRecoveryStage): string {
  switch (stage) {
    case "verifying_vercel":
      return "Verifying Vercel";
    case "preparing_bridge":
      return "Preparing automation bridge";
    case "deploying_bridge":
      return "Deploying bridge";
    case "verifying_webhook":
      return "Verifying webhook";
    case "connecting_linear":
      return "Connecting Linear";
    case "ready":
      return "Ready";
    case "needs_scope":
      return "Select Vercel scope";
    case "needs_bridge":
      return "Select bridge project";
    case "failed":
      return "Needs attention";
  }
}

export function isNonterminalRecoveryStage(stage: VercelRecoveryStage): boolean {
  return stage !== "ready";
}
