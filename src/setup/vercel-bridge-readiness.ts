export const REQUIRED_VERCEL_BRIDGE_ENV_VARS = [
  "LINEAR_WEBHOOK_SECRET",
  "GITHUB_DISPATCH_TOKEN",
  "HARNESS_TEAM_KEY",
] as const;

export type VercelBridgeEnvVarName =
  (typeof REQUIRED_VERCEL_BRIDGE_ENV_VARS)[number];

export const OPTIONAL_VERCEL_BRIDGE_ENV_VARS = [
  "GITHUB_DISPATCH_REPOSITORY",
  "GITHUB_DISPATCH_EVENT_TYPE",
  "LINEAR_WEBHOOK_TIMESTAMP_TOLERANCE_MS",
  "P_DEV_WORKFLOW_STATE_REPOSITORY",
  "P_DEV_JOB_REQUEST_REPOSITORY",
  "P_DEV_WORKFLOW_STATE_BRANCH",
] as const;

export type OptionalVercelBridgeEnvVarName =
  (typeof OPTIONAL_VERCEL_BRIDGE_ENV_VARS)[number];

export const DEFAULT_VERCEL_BRIDGE_ENV_DEFAULTS: Record<
  OptionalVercelBridgeEnvVarName,
  string
> = {
  GITHUB_DISPATCH_REPOSITORY: "weston-uribe/p-dev-harness-runner",
  GITHUB_DISPATCH_EVENT_TYPE: "linear_issue_status_changed",
  LINEAR_WEBHOOK_TIMESTAMP_TOLERANCE_MS: "60000",
  P_DEV_WORKFLOW_STATE_REPOSITORY: "weston-uribe/p-dev-harness-state",
  P_DEV_JOB_REQUEST_REPOSITORY: "weston-uribe/p-dev-harness-state",
  P_DEV_WORKFLOW_STATE_BRANCH: "p-dev-runtime-state",
};

/** Bridge must also receive P_DEV_STATE_GITHUB_TOKEN (no default; never inlined in source). */
export const VERCEL_BRIDGE_STATE_TOKEN_ENV = "P_DEV_STATE_GITHUB_TOKEN";

export interface VercelBridgeReadiness {
  projectSelected: boolean;
  productionUrl?: string;
  webhookUrl?: string;
  endpointReachable: boolean;
  requiredEnvPresence: Record<VercelBridgeEnvVarName, "present" | "missing">;
  linearWebhookVerified: boolean;
  signedProbeVerified: boolean;
  deploymentRedeployRequired: boolean;
  manualComplete: boolean;
  ready: boolean;
  blockers: string[];
}

export function deriveVercelBridgeReadiness(input: {
  projectId?: string;
  productionUrl?: string;
  webhookUrl?: string;
  endpointReachable?: boolean;
  requiredEnvPresence?: Partial<
    Record<VercelBridgeEnvVarName, "present" | "missing">
  >;
  linearWebhookVerified?: boolean;
  signedProbeVerified?: boolean;
  deploymentRedeployRequired?: boolean;
  manualComplete?: boolean;
  orchestrationActive?: boolean;
}): VercelBridgeReadiness {
  const requiredEnvPresence = {
    LINEAR_WEBHOOK_SECRET:
      input.requiredEnvPresence?.LINEAR_WEBHOOK_SECRET ?? "missing",
    GITHUB_DISPATCH_TOKEN:
      input.requiredEnvPresence?.GITHUB_DISPATCH_TOKEN ?? "missing",
    HARNESS_TEAM_KEY: input.requiredEnvPresence?.HARNESS_TEAM_KEY ?? "missing",
  } satisfies Record<VercelBridgeEnvVarName, "present" | "missing">;

  const blockers: string[] = [];
  if (!input.projectId) {
    blockers.push("Select the Vercel bridge project.");
  }
  if (!input.productionUrl) {
    blockers.push("Resolve the Vercel production URL for the bridge project.");
  }
  if (!input.endpointReachable) {
    blockers.push(
      "Verify /api/linear-webhook is reachable on the production URL.",
    );
  }
  for (const [key, status] of Object.entries(requiredEnvPresence)) {
    if (status === "missing") {
      blockers.push(`Vercel production env var ${key} is missing.`);
    }
  }
  if (!input.linearWebhookVerified) {
    blockers.push(
      "Verify the Linear Issue webhook points at the Vercel bridge URL.",
    );
  }
  if (!input.signedProbeVerified) {
    blockers.push(
      "Signed webhook delivery verification has not passed against production.",
    );
  }
  if (input.deploymentRedeployRequired && !input.orchestrationActive) {
    blockers.push(
      "Redeploy Vercel production after env var changes, then retry signed verification.",
    );
  }

  const ready =
    blockers.length === 0 &&
    Boolean(input.projectId) &&
    Boolean(input.productionUrl) &&
    Boolean(input.endpointReachable) &&
    input.linearWebhookVerified === true &&
    input.signedProbeVerified === true &&
    input.deploymentRedeployRequired !== true;

  return {
    projectSelected: Boolean(input.projectId),
    productionUrl: input.productionUrl,
    webhookUrl: input.webhookUrl,
    endpointReachable: Boolean(input.endpointReachable),
    requiredEnvPresence,
    linearWebhookVerified: Boolean(input.linearWebhookVerified),
    signedProbeVerified: Boolean(input.signedProbeVerified),
    deploymentRedeployRequired: Boolean(input.deploymentRedeployRequired),
    manualComplete: Boolean(input.manualComplete),
    ready,
    blockers,
  };
}

/**
 * Whether preview blockers are final-readiness gaps that apply can repair,
 * vs hard inputs/permissions that must block apply.
 * Do not weaken deriveVercelBridgeReadiness — this only gates repair attempts.
 */
export type VercelBridgeRepairEligibility = {
  repairAllowed: boolean;
  hardBlockers: string[];
  repairableBlockers: string[];
  reason?: string;
};

const REPAIRABLE_BLOCKER_PATTERNS: RegExp[] = [
  /resolve the vercel production url/i,
  /\/api\/linear-webhook is reachable/i,
  /vercel production env var .+ is missing/i,
  /linear issue webhook points at the vercel bridge/i,
  /signed webhook delivery verification has not passed/i,
  /redeploy vercel production after env var changes/i,
];

const HARD_BLOCKER_PATTERNS: RegExp[] = [
  /select the vercel bridge project/i,
  /deployment protection/i,
  /protection_redirect/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid token/i,
  /vercel_token is required/i,
  /github.?dispatch/i,
];

function classifyReadinessBlocker(
  blocker: string,
): "repairable" | "hard" | "unknown" {
  if (REPAIRABLE_BLOCKER_PATTERNS.some((pattern) => pattern.test(blocker))) {
    return "repairable";
  }
  if (HARD_BLOCKER_PATTERNS.some((pattern) => pattern.test(blocker))) {
    return "hard";
  }
  return "unknown";
}

export function deriveVercelBridgeRepairEligibility(input: {
  validationError?: string;
  readiness: Pick<VercelBridgeReadiness, "ready" | "blockers" | "projectSelected">;
  endpointStatusCode?: number;
  signedProbeReason?: string;
}): VercelBridgeRepairEligibility {
  const hardBlockers: string[] = [];
  const repairableBlockers: string[] = [];

  if (input.validationError?.trim()) {
    hardBlockers.push(input.validationError.trim());
  }

  const probeReason = input.signedProbeReason?.trim() ?? "";
  if (/protection_redirect/i.test(probeReason)) {
    hardBlockers.push(
      "Vercel Deployment Protection is blocking signed webhook verification.",
    );
  }
  if (input.endpointStatusCode === 401 || input.endpointStatusCode === 403) {
    // Unreachable due to auth on the route itself can still be repairable via
    // secret/env sync unless protection redirect is also indicated.
    if (/protection/i.test(probeReason)) {
      hardBlockers.push(
        `Production bridge endpoint returned HTTP ${input.endpointStatusCode}.`,
      );
    }
  }

  for (const blocker of input.readiness.blockers) {
    const kind = classifyReadinessBlocker(blocker);
    if (kind === "repairable") {
      repairableBlockers.push(blocker);
    } else if (kind === "hard") {
      hardBlockers.push(blocker);
    } else if (!input.readiness.projectSelected) {
      hardBlockers.push(blocker);
    } else {
      // Unknown blockers with a selected project are treated as repairable so
      // apply can attempt the known repair path rather than dead-ending.
      repairableBlockers.push(blocker);
    }
  }

  if (input.readiness.ready && hardBlockers.length === 0) {
    return {
      repairAllowed: true,
      hardBlockers: [],
      repairableBlockers: [],
      reason: "Bridge already meets final readiness.",
    };
  }

  const repairAllowed = hardBlockers.length === 0;
  return {
    repairAllowed,
    hardBlockers,
    repairableBlockers,
    reason: repairAllowed
      ? repairableBlockers.length > 0
        ? "Preview gaps are repairable by apply (webhook, env, deploy, or signed probe)."
        : "Repair allowed."
      : hardBlockers.join(" "),
  };
}

export function isVercelBridgeStale(input: {
  configuredTeamKey?: string;
  selectedTeamKey?: string;
  configuredProjectId?: string;
  selectedProjectId?: string;
  configuredProductionUrl?: string;
  selectedProductionUrl?: string;
}): boolean {
  if (
    input.configuredTeamKey &&
    input.selectedTeamKey &&
    input.configuredTeamKey !== input.selectedTeamKey
  ) {
    return true;
  }
  if (
    input.configuredProjectId &&
    input.selectedProjectId &&
    input.configuredProjectId !== input.selectedProjectId
  ) {
    return true;
  }
  if (
    input.configuredProductionUrl &&
    input.selectedProductionUrl &&
    input.configuredProductionUrl !== input.selectedProductionUrl
  ) {
    return true;
  }
  return false;
}
