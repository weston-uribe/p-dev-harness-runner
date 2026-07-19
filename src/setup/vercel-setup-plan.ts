import { createHash } from "node:crypto";
import {
  checkWebhookEndpointReachable,
  findExistingProjectByName,
  findExistingTeamBySlug,
  getDefaultEnvVarType,
  listVercelProjectEnvVars,
  listVercelProjects,
  listVercelTeams,
  resolveCanonicalProductionTarget,
  summarizeRequiredEnvPresence,
  type VercelEnvVarSummary,
  type VercelProductionUrlSource,
} from "./vercel-setup-client.js";
import {
  DEFAULT_VERCEL_BRIDGE_ENV_DEFAULTS,
  deriveVercelBridgeReadiness,
  OPTIONAL_VERCEL_BRIDGE_ENV_VARS,
  REQUIRED_VERCEL_BRIDGE_ENV_VARS,
  type VercelBridgeEnvVarName,
} from "./vercel-bridge-readiness.js";
import { summarizeLinearWebhookReadiness } from "./linear-setup-plan.js";
import { planLinearWebhookSecret } from "./linear-webhook-secret.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";
import { tokenizeSecretInput } from "./secret-change-token.js";
import { validateVercelProjectName } from "./vercel-project-name.js";

export const VERCEL_SETUP_ACTIONS = {
  preview: {
    id: "preview-vercel-bridge",
    permission: SETUP_PERMISSIONS.remoteRead,
  },
  apply: {
    id: "apply-vercel-bridge",
    permission: SETUP_PERMISSIONS.remoteSecretWrite,
  },
} as const;

export interface VercelBridgeEnvInput {
  LINEAR_WEBHOOK_SECRET?: string;
  GITHUB_DISPATCH_TOKEN?: string;
  HARNESS_TEAM_KEY?: string;
  GITHUB_DISPATCH_REPOSITORY?: string;
  GITHUB_DISPATCH_EVENT_TYPE?: string;
  LINEAR_WEBHOOK_TIMESTAMP_TOLERANCE_MS?: string;
  P_DEV_WORKFLOW_STATE_REPOSITORY?: string;
  P_DEV_JOB_REQUEST_REPOSITORY?: string;
  P_DEV_WORKFLOW_STATE_BRANCH?: string;
}

export interface VercelBridgeTeamInput {
  mode: "existing" | "create";
  teamId?: string;
  teamName?: string;
  teamSlug?: string;
}

export interface VercelBridgeProjectInput {
  mode: "existing" | "create";
  projectId?: string;
  projectName?: string;
}

export interface VercelBridgePlanInput {
  vercelToken: string;
  teamId?: string;
  projectId?: string;
  projectName?: string;
  team?: VercelBridgeTeamInput;
  project?: VercelBridgeProjectInput;
  linearApiKey?: string;
  linearTeamId?: string;
  envInput?: VercelBridgeEnvInput;
  derivedHarnessTeamKey?: string;
  derivedGithubDispatchToken?: string;
  derivedGithubDispatchRepository?: string;
  willGenerateLinearWebhookSecret?: boolean;
  /** Raw secret for verify/retry paths only; does not affect preview fingerprinting. */
  verificationLinearWebhookSecret?: string;
  /** Keep generated-secret preview semantics ("generate-on-apply") while verifying. */
  preserveGeneratedWebhookSecretFingerprint?: boolean;
  /** When set, resolve production URL from this READY deployment (post-redeploy verify). */
  preferredProductionDeploymentId?: string;
  /** Allows installing the bridge into an existing project without a PDev marker. */
  allowExistingProjectBridgeInstall?: boolean;
}

export interface VercelEnvWritePlanEntry {
  key: VercelBridgeEnvVarName | (typeof OPTIONAL_VERCEL_BRIDGE_ENV_VARS)[number];
  action: "create" | "update" | "skip";
  source:
    | "operator-input"
    | "default"
    | "preserve-existing"
    | "missing-input"
    | "derived"
    | "generated";
  existingType?: string;
  desiredType?: string;
}

export interface VercelBridgePreview {
  actionId: string;
  teams: Awaited<ReturnType<typeof listVercelTeams>>;
  projects: Awaited<ReturnType<typeof listVercelProjects>>;
  selectedProject?: Awaited<ReturnType<typeof listVercelProjects>>[number];
  productionUrl?: string;
  webhookUrl?: string;
  productionUrlSource?: VercelProductionUrlSource;
  canonicalDeploymentId?: string;
  deploymentStatus: "ready" | "missing" | "project-will-be-created";
  deploymentRequired?: {
    message: string;
    nextSteps: string[];
  };
  endpointReachable: boolean;
  endpointStatusCode?: number;
  envWritePlan: VercelEnvWritePlanEntry[];
  requiredEnvPresence: Record<VercelBridgeEnvVarName, "present" | "missing">;
  linearWebhookVerified: boolean;
  signedProbeVerified?: boolean;
  deploymentRedeployRequired?: boolean;
  signedProbeReason?: string;
  linearWebhookSecretMode?: "automated" | "existing-unverified" | "manual-copy";
  githubDispatchSource?: "saved-github-token" | "operator-input" | "missing";
  readiness: ReturnType<typeof deriveVercelBridgeReadiness>;
  manualSteps: string[];
  fingerprint: string;
  permission: typeof SETUP_PERMISSIONS.remoteRead;
  validationError?: string;
}

function hashPreview(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

export function buildVercelBridgePreviewFingerprintInput(input: {
  teamId?: string;
  teamMode?: string;
  teamSlug?: string;
  projectId: string;
  projectMode?: string;
  projectName?: string;
  envWritePlan: VercelEnvWritePlanEntry[];
  willGenerateLinearWebhookSecret: boolean;
  linearWebhookSecretFromEnv?: string;
  githubDispatchTokenFromEnv?: string;
  derivedGithubDispatchToken?: string;
  harnessTeamKey?: string;
  derivedHarnessTeamKey?: string;
  vercelToken: string;
  allowExistingProjectBridgeInstall?: boolean;
}): import("./control-plane-types.js").VercelBridgePreviewFingerprintInputs {
  return {
    actionId: VERCEL_SETUP_ACTIONS.preview.id,
    teamId: input.teamId,
    teamMode: input.teamMode,
    teamSlug: input.teamSlug,
    projectId: input.projectId,
    projectMode: input.projectMode,
    projectName: input.projectName,
    envWritePlan: input.envWritePlan.map((entry) => ({
      key: entry.key,
      action: entry.action,
      source: entry.source,
      existingType: entry.existingType,
      desiredType: entry.desiredType,
    })),
    linearWebhookSecretToken: input.willGenerateLinearWebhookSecret
      ? "generate-on-apply"
      : tokenizeSecretInput(input.linearWebhookSecretFromEnv),
    githubDispatchTokenToken: tokenizeSecretInput(
      input.githubDispatchTokenFromEnv ?? input.derivedGithubDispatchToken,
    ),
    harnessTeamKey: input.harnessTeamKey ?? input.derivedHarnessTeamKey ?? "",
    vercelTokenToken: tokenizeSecretInput(input.vercelToken),
    allowExistingProjectBridgeInstall: input.allowExistingProjectBridgeInstall,
  };
}

export function hashVercelBridgePreviewFingerprint(
  input: import("./control-plane-types.js").VercelBridgePreviewFingerprintInputs,
): string {
  return hashPreview(input);
}

export function diffVercelBridgePreviewFingerprintInputs(
  original: import("./control-plane-types.js").VercelBridgePreviewFingerprintInputs,
  reconstructed: import("./control-plane-types.js").VercelBridgePreviewFingerprintInputs,
): string[] {
  const differingKeys: string[] = [];
  const keys = new Set([
    ...Object.keys(original),
    ...Object.keys(reconstructed),
  ] as Array<keyof typeof original>);

  for (const key of keys) {
    const left = original[key];
    const right = reconstructed[key];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      differingKeys.push(String(key));
    }
  }
  return differingKeys;
}

/**
 * After apply writes env vars and triggers redeploy, reconstructed preview
 * fingerprints often drift on envWritePlan / derived token fields even when
 * the same team/project/token identity is intact. Allow that expected drift
 * so poll can continue verify-only apply.
 */
export function isAcceptableRedeployFingerprintDrift(input: {
  original: import("./control-plane-types.js").VercelBridgePreviewFingerprintInputs;
  reconstructed: import("./control-plane-types.js").VercelBridgePreviewFingerprintInputs;
}): boolean {
  if (input.original.projectId !== input.reconstructed.projectId) {
    return false;
  }
  if ((input.original.teamId ?? "") !== (input.reconstructed.teamId ?? "")) {
    return false;
  }
  if (input.original.vercelTokenToken !== input.reconstructed.vercelTokenToken) {
    return false;
  }

  const differing = diffVercelBridgePreviewFingerprintInputs(
    input.original,
    input.reconstructed,
  );
  const allowed = new Set([
    "envWritePlan",
    "githubDispatchTokenToken",
    "harnessTeamKey",
    "allowExistingProjectBridgeInstall",
    "linearWebhookSecretToken",
  ]);
  return differing.every((key) => allowed.has(key));
}

export function buildDeploymentRequiredDetail(input: {
  projectName: string;
  projectJustCreated: boolean;
}): { message: string; nextSteps: string[] } {
  if (input.projectJustCreated) {
    return {
      message: `Project "${input.projectName}" was created in Vercel, but it has no production deployment yet.`,
      nextSteps: [
        "Deploy or connect the project in Vercel so it has a production URL.",
        "Return here, select the project under Use existing project, and apply again.",
      ],
    };
  }

  return {
    message: `Project "${input.projectName}" exists in Vercel but has no production deployment yet.`,
    nextSteps: [
      "Deploy the project in Vercel before applying settings.",
      "After deployment completes, preview and apply again.",
    ],
  };
}

export function normalizeVercelBridgePlanInput(
  input: VercelBridgePlanInput,
): VercelBridgePlanInput {
  const teamMode = input.team?.mode ?? "existing";
  const projectMode = input.project?.mode ?? "existing";

  return {
    ...input,
    teamId:
      teamMode === "existing"
        ? (input.team?.teamId ?? input.teamId)
        : input.teamId,
    projectId:
      projectMode === "existing"
        ? (input.project?.projectId ?? input.projectId)
        : input.projectId,
    projectName:
      projectMode === "create"
        ? (input.project?.projectName ?? input.projectName)
        : input.projectName,
    team: input.team ?? {
      mode: "existing",
      teamId: input.teamId,
    },
    project: input.project ?? {
      mode: "existing",
      projectId: input.projectId,
      projectName: input.projectName,
    },
  };
}

function validateTeamProjectSelection(input: VercelBridgePlanInput): string | undefined {
  const normalized = normalizeVercelBridgePlanInput(input);

  if (normalized.team?.mode === "create") {
    if (!normalized.team.teamSlug?.trim()) {
      return "New Vercel team requires a team slug.";
    }
  } else if (!normalized.teamId && normalized.team?.teamId !== "") {
    // Personal account uses empty string teamId; undefined means not selected when teams exist
  }

  if (normalized.project?.mode === "create") {
    const nameValidation = validateVercelProjectName(
      normalized.project.projectName ?? normalized.projectName,
    );
    if (!nameValidation.valid) {
      return nameValidation.error;
    }
  } else if (!normalized.projectId?.trim()) {
    return "Vercel project is required.";
  }

  return undefined;
}

function buildEnvWritePlan(input: {
  existingEnvByKey: Map<string, VercelEnvVarSummary>;
  envInput?: VercelBridgeEnvInput;
  derivedHarnessTeamKey?: string;
  derivedGithubDispatchToken?: string;
  derivedGithubDispatchRepository?: string;
  willGenerateLinearWebhookSecret?: boolean;
}): VercelEnvWritePlanEntry[] {
  const plan: VercelEnvWritePlanEntry[] = [];
  const existingKeys = new Set(input.existingEnvByKey.keys());

  const resolveRequired = (
    key: (typeof REQUIRED_VERCEL_BRIDGE_ENV_VARS)[number],
  ): { value?: string; source: VercelEnvWritePlanEntry["source"] } => {
    const operatorValue = input.envInput?.[key]?.trim();
    if (operatorValue) {
      return { value: operatorValue, source: "operator-input" };
    }
    if (key === "HARNESS_TEAM_KEY" && input.derivedHarnessTeamKey?.trim()) {
      return {
        value: input.derivedHarnessTeamKey.trim(),
        source: "derived",
      };
    }
    if (
      key === "GITHUB_DISPATCH_TOKEN" &&
      input.derivedGithubDispatchToken?.trim()
    ) {
      return {
        value: input.derivedGithubDispatchToken.trim(),
        source: "derived",
      };
    }
    if (
      key === "LINEAR_WEBHOOK_SECRET" &&
      input.willGenerateLinearWebhookSecret
    ) {
      return { value: "<generated-on-apply>", source: "generated" };
    }
    if (existingKeys.has(key)) {
      return { value: undefined, source: "preserve-existing" };
    }
    return { value: undefined, source: "missing-input" };
  };

  for (const key of REQUIRED_VERCEL_BRIDGE_ENV_VARS) {
    const resolved = resolveRequired(key);
    const existing = input.existingEnvByKey.get(key);
    const desiredType = getDefaultEnvVarType(key);
    if (resolved.source === "preserve-existing") {
      plan.push({
        key,
        action: "skip",
        source: "preserve-existing",
        existingType: existing?.type,
        desiredType,
      });
      continue;
    }
    if (resolved.source === "missing-input" || !resolved.value) {
      plan.push({ key, action: "skip", source: "missing-input", desiredType });
      continue;
    }
    plan.push({
      key,
      action: existingKeys.has(key) ? "update" : "create",
      source: resolved.source,
      existingType: existing?.type,
      desiredType: existing?.type ?? desiredType,
    });
  }

  for (const key of OPTIONAL_VERCEL_BRIDGE_ENV_VARS) {
    const operatorValue = input.envInput?.[key]?.trim();
    const derivedValue =
      key === "GITHUB_DISPATCH_REPOSITORY"
        ? input.derivedGithubDispatchRepository?.trim()
        : undefined;
    const value =
      operatorValue ?? derivedValue ?? DEFAULT_VERCEL_BRIDGE_ENV_DEFAULTS[key];
    const existing = input.existingEnvByKey.get(key);
    const desiredType = getDefaultEnvVarType(key);
    if (!value) {
      plan.push({ key, action: "skip", source: "missing-input", desiredType });
      continue;
    }
    if (existingKeys.has(key)) {
      plan.push({
        key,
        action: "skip",
        source: "preserve-existing",
        existingType: existing?.type,
        desiredType,
      });
      continue;
    }
    plan.push({
      key,
      action: "create",
      source: operatorValue ? "operator-input" : derivedValue ? "derived" : "default",
      desiredType,
    });
  }

  return plan;
}

export function resolveVercelBridgeEnvValue(input: {
  key: VercelEnvWritePlanEntry["key"];
  envInput?: VercelBridgeEnvInput;
  derivedHarnessTeamKey?: string;
  derivedGithubDispatchToken?: string;
  derivedGithubDispatchRepository?: string;
  generatedLinearWebhookSecret?: string;
}): string | undefined {
  const operatorValue = input.envInput?.[
    input.key as keyof VercelBridgeEnvInput
  ]?.trim();
  if (operatorValue) {
    return operatorValue;
  }
  if (input.key === "HARNESS_TEAM_KEY" && input.derivedHarnessTeamKey?.trim()) {
    return input.derivedHarnessTeamKey.trim();
  }
  if (
    input.key === "GITHUB_DISPATCH_TOKEN" &&
    input.derivedGithubDispatchToken?.trim()
  ) {
    return input.derivedGithubDispatchToken.trim();
  }
  if (
    input.key === "GITHUB_DISPATCH_REPOSITORY" &&
    input.derivedGithubDispatchRepository?.trim()
  ) {
    return input.derivedGithubDispatchRepository.trim();
  }
  if (
    input.key === "LINEAR_WEBHOOK_SECRET" &&
    input.generatedLinearWebhookSecret?.trim()
  ) {
    return input.generatedLinearWebhookSecret.trim();
  }
  if (input.key in DEFAULT_VERCEL_BRIDGE_ENV_DEFAULTS) {
    return DEFAULT_VERCEL_BRIDGE_ENV_DEFAULTS[
      input.key as keyof typeof DEFAULT_VERCEL_BRIDGE_ENV_DEFAULTS
    ];
  }
  return undefined;
}

export async function previewVercelBridgeSetup(
  input: VercelBridgePlanInput,
): Promise<VercelBridgePreview> {
  const normalized = normalizeVercelBridgePlanInput(input);

  if (!normalized.vercelToken.trim()) {
    return {
      actionId: VERCEL_SETUP_ACTIONS.preview.id,
      teams: [],
      projects: [],
      deploymentStatus: "missing",
      endpointReachable: false,
      envWritePlan: [],
      requiredEnvPresence: {
        LINEAR_WEBHOOK_SECRET: "missing",
        GITHUB_DISPATCH_TOKEN: "missing",
        HARNESS_TEAM_KEY: "missing",
      },
      linearWebhookVerified: false,
      readiness: deriveVercelBridgeReadiness({}),
      manualSteps: ["Add VERCEL_TOKEN in Step 1 before configuring Vercel settings."],
      fingerprint: hashPreview({ invalid: "missing-vercel-token" }),
      permission: VERCEL_SETUP_ACTIONS.preview.permission,
      validationError: "VERCEL_TOKEN is required for Vercel settings preview.",
    };
  }

  const selectionError = validateTeamProjectSelection(normalized);
  if (selectionError) {
    return {
      actionId: VERCEL_SETUP_ACTIONS.preview.id,
      teams: [],
      projects: [],
      deploymentStatus: "missing",
      endpointReachable: false,
      envWritePlan: [],
      requiredEnvPresence: {
        LINEAR_WEBHOOK_SECRET: "missing",
        GITHUB_DISPATCH_TOKEN: "missing",
        HARNESS_TEAM_KEY: "missing",
      },
      linearWebhookVerified: false,
      readiness: deriveVercelBridgeReadiness({}),
      manualSteps: [selectionError],
      fingerprint: hashPreview({ invalid: "invalid-selection" }),
      permission: VERCEL_SETUP_ACTIONS.preview.permission,
      validationError: selectionError,
    };
  }

  const teams = await listVercelTeams(normalized.vercelToken);
  const teamIdForProjects =
    normalized.team?.mode === "create"
      ? findExistingTeamBySlug(teams, normalized.team.teamSlug ?? "")?.id
      : normalized.teamId?.trim()
        ? normalized.teamId
        : undefined;

  const projects = await listVercelProjects(
    normalized.vercelToken,
    teamIdForProjects,
  );

  let selectedProject =
    normalized.project?.mode === "existing"
      ? projects.find((project) => project.id === normalized.projectId) ??
        projects.find((project) => project.id === normalized.project?.projectId)
      : findExistingProjectByName(projects, normalized.project?.projectName ?? "");

  if (!selectedProject && normalized.project?.mode === "create") {
    selectedProject = undefined;
  }

  if (!selectedProject) {
    const manualSteps =
      normalized.project?.mode === "create"
        ? [
            `Project "${normalized.project?.projectName}" will be created during apply if it does not already exist.`,
          ]
        : ["Select or enter the Vercel project for automation and preview checks."];
    const willGenerateLinearWebhookSecret =
      normalized.willGenerateLinearWebhookSecret ??
      !normalized.envInput?.LINEAR_WEBHOOK_SECRET?.trim();
    const envWritePlan =
      normalized.project?.mode === "create"
        ? buildEnvWritePlan({
            existingEnvByKey: new Map(),
            envInput: normalized.envInput,
            derivedHarnessTeamKey: normalized.derivedHarnessTeamKey,
            derivedGithubDispatchToken: normalized.derivedGithubDispatchToken,
            derivedGithubDispatchRepository:
              normalized.derivedGithubDispatchRepository,
            willGenerateLinearWebhookSecret,
          })
        : [];
    const githubDispatchSource = normalized.envInput?.GITHUB_DISPATCH_TOKEN?.trim()
      ? "operator-input"
      : normalized.derivedGithubDispatchToken?.trim()
        ? "saved-github-token"
        : "missing";
    const fingerprintInputs = buildVercelBridgePreviewFingerprintInput({
      teamId: teamIdForProjects,
      teamMode: normalized.team?.mode,
      teamSlug: normalized.team?.teamSlug,
      projectId: normalized.project?.projectName ?? "",
      projectMode: normalized.project?.mode,
      projectName: normalized.project?.projectName,
      envWritePlan,
      willGenerateLinearWebhookSecret,
      linearWebhookSecretFromEnv: normalized.envInput?.LINEAR_WEBHOOK_SECRET,
      githubDispatchTokenFromEnv: normalized.envInput?.GITHUB_DISPATCH_TOKEN,
      derivedGithubDispatchToken: normalized.derivedGithubDispatchToken,
      harnessTeamKey: normalized.envInput?.HARNESS_TEAM_KEY,
      derivedHarnessTeamKey: normalized.derivedHarnessTeamKey,
      vercelToken: normalized.vercelToken,
      allowExistingProjectBridgeInstall:
        normalized.allowExistingProjectBridgeInstall,
    });
    return {
      actionId: VERCEL_SETUP_ACTIONS.preview.id,
      teams,
      projects,
      deploymentStatus:
        normalized.project?.mode === "create"
          ? "project-will-be-created"
          : "missing",
      endpointReachable: false,
      envWritePlan,
      requiredEnvPresence: {
        LINEAR_WEBHOOK_SECRET: "missing",
        GITHUB_DISPATCH_TOKEN: "missing",
        HARNESS_TEAM_KEY: "missing",
      },
      linearWebhookVerified: false,
      readiness: deriveVercelBridgeReadiness({}),
      manualSteps,
      signedProbeVerified: false,
      linearWebhookSecretMode:
        normalized.project?.mode === "create" ? "manual-copy" : undefined,
      githubDispatchSource,
      fingerprint:
        normalized.project?.mode === "create"
          ? hashVercelBridgePreviewFingerprint(fingerprintInputs)
          : hashPreview({
              invalid: "missing-project",
              teamId: teamIdForProjects,
              teamMode: normalized.team?.mode,
              teamSlug: normalized.team?.teamSlug,
              projectMode: normalized.project?.mode,
              projectName: normalized.project?.projectName,
            }),
      permission: VERCEL_SETUP_ACTIONS.preview.permission,
      validationError:
        normalized.project?.mode === "create"
          ? undefined
          : "Vercel project is required.",
    };
  }

  const productionTarget = await resolveCanonicalProductionTarget({
    vercelToken: normalized.vercelToken,
    projectId: selectedProject.id,
    teamId: teamIdForProjects,
    preferredDeploymentId: normalized.preferredProductionDeploymentId,
  });
  const productionUrl = productionTarget?.productionUrl;
  const webhookUrl = productionTarget?.webhookUrl;
  const deploymentStatus = webhookUrl ? "ready" : "missing";
  const deploymentRequired = webhookUrl
    ? undefined
    : buildDeploymentRequiredDetail({
        projectName: selectedProject.name,
        projectJustCreated: normalized.project?.mode === "create",
      });
  const endpoint = webhookUrl
    ? await checkWebhookEndpointReachable(webhookUrl)
    : { reachable: false };

  const envVars = await listVercelProjectEnvVars(
    normalized.vercelToken,
    selectedProject.id,
    teamIdForProjects,
  );
  const existingEnvByKey = new Map(envVars.map((env) => [env.key, env]));
  const requiredEnvPresence = summarizeRequiredEnvPresence(envVars);

  let linearWebhookVerified = false;
  let linearWebhookSecretMode:
    | "automated"
    | "existing-unverified"
    | "manual-copy"
    | undefined;
  let secretPlan: Awaited<ReturnType<typeof planLinearWebhookSecret>> | undefined;
  const manualSteps: string[] = [];
  if (normalized.team?.mode === "create" && !teamIdForProjects) {
    manualSteps.push(
      `Team "${normalized.team.teamSlug}" will be created during apply if it does not already exist.`,
    );
  }
  if (normalized.linearApiKey && webhookUrl) {
    const webhookSummary = await summarizeLinearWebhookReadiness({
      linearApiKey: normalized.linearApiKey,
      webhookUrl,
      teamId: normalized.linearTeamId,
    });
    secretPlan = await planLinearWebhookSecret({
      linearApiKey: normalized.linearApiKey,
      webhookUrl,
      linearTeamId: normalized.linearTeamId,
    });
    linearWebhookSecretMode = secretPlan.mode;
    linearWebhookVerified = false;
    if (secretPlan.mode === "existing-unverified") {
      linearWebhookVerified = false;
    }
    manualSteps.push(...webhookSummary.manualSteps, ...secretPlan.manualSteps);
  } else if (!webhookUrl) {
    manualSteps.push(
      deploymentRequired?.message ??
        "No production deployment was found for the selected Vercel project yet. Deploy the project before automation checks can pass.",
      ...(deploymentRequired?.nextSteps ?? []),
    );
    linearWebhookSecretMode = "manual-copy";
  } else {
    manualSteps.push(
      "After Vercel env vars are configured, create or verify the Linear Issue webhook.",
    );
    linearWebhookSecretMode = "manual-copy";
  }

  const willGenerateLinearWebhookSecret =
    normalized.willGenerateLinearWebhookSecret ??
    (secretPlan?.willGenerateOnApply ??
      !normalized.envInput?.LINEAR_WEBHOOK_SECRET?.trim());
  const envWritePlan = buildEnvWritePlan({
    existingEnvByKey,
    envInput: normalized.envInput,
    derivedHarnessTeamKey: normalized.derivedHarnessTeamKey,
    derivedGithubDispatchToken: normalized.derivedGithubDispatchToken,
    derivedGithubDispatchRepository: normalized.derivedGithubDispatchRepository,
    willGenerateLinearWebhookSecret,
  });

  const githubDispatchSource = normalized.envInput?.GITHUB_DISPATCH_TOKEN?.trim()
    ? "operator-input"
    : normalized.derivedGithubDispatchToken?.trim()
      ? "saved-github-token"
      : "missing";

  const readiness = deriveVercelBridgeReadiness({
    projectId: selectedProject.id,
    productionUrl,
    webhookUrl,
    endpointReachable: endpoint.reachable,
    requiredEnvPresence,
    linearWebhookVerified,
    signedProbeVerified: false,
    deploymentRedeployRequired: false,
  });

  const fingerprintInputs = buildVercelBridgePreviewFingerprintInput({
    teamId: teamIdForProjects,
    teamMode: normalized.team?.mode,
    teamSlug: normalized.team?.teamSlug,
    projectId: selectedProject.id,
    projectMode: normalized.project?.mode,
    projectName: normalized.project?.projectName,
    envWritePlan,
    willGenerateLinearWebhookSecret,
    linearWebhookSecretFromEnv: normalized.envInput?.LINEAR_WEBHOOK_SECRET,
    githubDispatchTokenFromEnv: normalized.envInput?.GITHUB_DISPATCH_TOKEN,
    derivedGithubDispatchToken: normalized.derivedGithubDispatchToken,
    harnessTeamKey: normalized.envInput?.HARNESS_TEAM_KEY,
    derivedHarnessTeamKey: normalized.derivedHarnessTeamKey,
    vercelToken: normalized.vercelToken,
    allowExistingProjectBridgeInstall:
      normalized.allowExistingProjectBridgeInstall,
  });
  const fingerprint = hashVercelBridgePreviewFingerprint(fingerprintInputs);

  return {
    actionId: VERCEL_SETUP_ACTIONS.preview.id,
    teams,
    projects,
    selectedProject,
    productionUrl,
    webhookUrl,
    productionUrlSource: productionTarget?.source,
    canonicalDeploymentId: productionTarget?.deploymentId,
    deploymentStatus,
    deploymentRequired,
    endpointReachable: endpoint.reachable,
    endpointStatusCode: endpoint.statusCode,
    envWritePlan,
    requiredEnvPresence,
    linearWebhookVerified,
    signedProbeVerified: false,
    deploymentRedeployRequired: false,
    linearWebhookSecretMode,
    githubDispatchSource,
    readiness,
    manualSteps,
    fingerprint,
    permission: VERCEL_SETUP_ACTIONS.preview.permission,
  };
}
