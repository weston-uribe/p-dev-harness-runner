import {
  updateControlPlaneSetupState,
  readControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import type { VercelBridgeSelection, VercelBridgeOrchestrationPhase } from "./control-plane-types.js";
import {
  ensureLinearIssueWebhook,
  generateLinearWebhookSecret,
  reconcileLinearWebhookUrlForVerification,
  resolveLinearWebhookCandidateSecret,
  type LinearWebhookCandidateSource,
  type LinearWebhookSecretMode,
  type LinearWebhookUrlReconciliationResult,
} from "./linear-webhook-secret.js";
import { summarizeLinearWebhookReadiness } from "./linear-setup-plan.js";
import {
  assertRemoteSetupConfirmed,
  assertRemoteSetupFingerprint,
  assertRemoteSetupPermissionScope,
} from "./remote-actions.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";
import { collectRemoteSecretInputs } from "./redact-secrets.js";
import {
  createVercelProject,
  createVercelTeam,
  findExistingProjectByName,
  findExistingTeamBySlug,
  checkWebhookEndpointReachable,
  listVercelProjectEnvVars,
  listVercelProjects,
  listVercelTeams,
  resolveCanonicalProductionTarget,
  summarizeRequiredEnvPresence,
  upsertVercelProjectEnvVar,
  VercelEnvVarTypeError,
  type VercelProjectSummary,
} from "./vercel-setup-client.js";
import {
  buildVercelBridgeVerificationFingerprint,
  tokenizeCandidateWebhookSecret,
} from "./vercel-bridge-verification.js";
import { runSignedWebhookProbe } from "./vercel-webhook-probe.js";
import type { VercelSignedProbeEvidence } from "./vercel-webhook-probe.js";
import {
  isAutoRedeployEligible,
  isStaleDeploymentSignatureProbeFailure,
  triggerProductionRedeployOnce,
  findLatestReadyProductionDeploymentId,
  type ProductionRedeployStatus,
} from "./vercel-production-redeploy.js";
import { createPendingRedeployVerification } from "./vercel-bridge-redeploy-state.js";
import { persistGeneratedLinearWebhookSecret } from "./linear-webhook-env-local.js";
import { assessGitHubDispatchTokenEligibility } from "./github-dispatch-token.js";
import { loadSecretFromEnvLocal } from "./service-verification.js";
import { REQUIRED_VERCEL_BRIDGE_ENV_VARS } from "./vercel-bridge-readiness.js";
import {
  VERCEL_SETUP_ACTIONS,
  buildDeploymentRequiredDetail,
  buildVercelBridgePreviewFingerprintInput,
  normalizeVercelBridgePlanInput,
  previewVercelBridgeSetup,
  resolveVercelBridgeEnvValue,
  type VercelBridgePlanInput,
  type VercelBridgePreview,
} from "./vercel-setup-plan.js";
import type { VercelBridgePreviewFingerprintInputs } from "./control-plane-types.js";
import { logVercelBridgeEvent } from "./vercel-bridge-structured-log.js";
import { validateVercelProjectName } from "./vercel-project-name.js";
import {
  PDEV_BRIDGE_PROJECT_MARKER_ENV,
  PDEV_BRIDGE_PROJECT_MARKER_VALUE,
  hasPDevBridgeProjectMarker,
} from "./vercel-bridge-project-marker.js";
import {
  deployVercelBridgeProduction,
  resolvePreferredVercelBridgeSource,
} from "./vercel-bridge-deploy.js";

export interface VercelBridgeLinearWebhookSetupResult {
  mode: LinearWebhookSecretMode;
  manualSteps: string[];
  manualCopySecret?: string;
}

export interface VercelBridgeResourceResult {
  id: string;
  name: string;
  outcome: "created" | "reused";
}

export interface VercelBridgeDeploymentRequired {
  message: string;
  nextSteps: string[];
  projectJustCreated: boolean;
}

export interface VercelBridgeSetupBlocked {
  message: string;
  nextSteps: string[];
}

export interface VercelBridgeOrchestrationStep {
  phase:
    | "writing_env_vars"
    | "deploying_bridge"
    | "redeploying_production"
    | "verifying_webhook";
  status: "completed" | "failed" | "active";
  message: string;
}

export interface VercelBridgeApplyResult {
  actionId: string;
  status: "applied" | "deployment-required";
  projectId: string;
  projectName: string;
  team?: VercelBridgeResourceResult;
  project?: VercelBridgeResourceResult;
  writtenEnvKeys: string[];
  skippedEnvKeys: string[];
  linearWebhookSetup: VercelBridgeLinearWebhookSetupResult;
  deploymentRequired?: VercelBridgeDeploymentRequired;
  signedProbeVerified: boolean;
  signedProbeReason?: string;
  signedProbe?: VercelSignedProbeEvidence;
  deploymentRedeployRequired: boolean;
  verificationRetry?: boolean;
  candidateSecretSource?: LinearWebhookCandidateSource;
  verified: boolean;
  fingerprint: string;
  permission: typeof SETUP_PERMISSIONS.remoteSecretWrite;
  envVarsWritten?: boolean;
  signedProbeInitialResult?: VercelSignedProbeEvidence;
  productionRedeployTriggered?: boolean;
  productionRedeployStatus?: ProductionRedeployStatus;
  signedProbeRetryResult?: VercelSignedProbeEvidence;
  setupBlocked?: VercelBridgeSetupBlocked;
  orchestrationSteps?: VercelBridgeOrchestrationStep[];
  setupPending?: boolean;
  pollActionId?: string;
  orchestrationPhase?: VercelBridgeOrchestrationPhase;
  orchestrationStatusMessage?: string;
  verificationAttemptCount?: number;
  maxVerificationAttempts?: number;
}

async function resolveVercelTeamForApply(input: {
  plan: VercelBridgePlanInput;
  created: string[];
  reused: string[];
}): Promise<{ teamId?: string; teamName?: string; team?: VercelBridgeResourceResult }> {
  const normalized = normalizeVercelBridgePlanInput(input.plan);

  if (normalized.team?.mode !== "create") {
    const teamId = normalized.teamId?.trim() ? normalized.teamId : undefined;
    const teams = await listVercelTeams(normalized.vercelToken);
    const existing = teamId
      ? teams.find((team) => team.id === teamId)
      : undefined;
    if (existing) {
      input.reused.push(`team:${existing.slug}`);
      return {
        teamId: existing.id,
        teamName: existing.name,
        team: {
          id: existing.id,
          name: existing.name,
          outcome: "reused",
        },
      };
    }
    return {
      teamId,
    };
  }

  const slug = normalized.team.teamSlug?.trim();
  if (!slug) {
    throw new Error("New Vercel team requires a team slug.");
  }

  const teams = await listVercelTeams(normalized.vercelToken);
  const existing = findExistingTeamBySlug(teams, slug);
  if (existing) {
    input.reused.push(`team:${existing.slug}`);
    return {
      teamId: existing.id,
      teamName: existing.name,
      team: {
        id: existing.id,
        name: existing.name,
        outcome: "reused",
      },
    };
  }

  const createdTeam = await createVercelTeam(normalized.vercelToken, {
    slug,
    name: normalized.team.teamName,
  });
  input.created.push(`team:${createdTeam.slug}`);
  return {
    teamId: createdTeam.id,
    teamName: createdTeam.name,
    team: {
      id: createdTeam.id,
      name: createdTeam.name,
      outcome: "created",
    },
  };
}

async function resolveVercelProjectForApply(input: {
  plan: VercelBridgePlanInput;
  teamId?: string;
  created: string[];
  reused: string[];
}): Promise<{
  project: VercelProjectSummary;
  projectResult: VercelBridgeResourceResult;
  preferredDeploymentSource: "git" | "artifact";
}> {
  const normalized = normalizeVercelBridgePlanInput(input.plan);
  const projects = await listVercelProjects(normalized.vercelToken, input.teamId);

  if (normalized.project?.mode === "existing") {
    const projectId = normalized.projectId ?? normalized.project.projectId;
    const existing = projects.find((project) => project.id === projectId);
    if (!existing) {
      throw new Error("Selected Vercel project is required for apply.");
    }
    input.reused.push(`project:${existing.name}`);
    return {
      project: existing,
      projectResult: {
        id: existing.id,
        name: existing.name,
        outcome: "reused",
      },
      preferredDeploymentSource: "artifact",
    };
  }

  const nameValidation = validateVercelProjectName(
    normalized.project?.projectName ?? normalized.projectName,
  );
  if (!nameValidation.valid) {
    throw new Error(nameValidation.error);
  }
  const projectName = nameValidation.normalized;

  const existing = findExistingProjectByName(projects, projectName);
  if (existing) {
    input.reused.push(`project:${existing.name}`);
    return {
      project: existing,
      projectResult: {
        id: existing.id,
        name: existing.name,
        outcome: "reused",
      },
      preferredDeploymentSource: "artifact",
    };
  }

  const source = await resolvePreferredVercelBridgeSource({
    vercelToken: normalized.vercelToken,
    teamId: input.teamId,
    repository: normalized.derivedGithubDispatchRepository,
  });
  const created = await createVercelProject(normalized.vercelToken, {
    name: projectName,
    teamId: input.teamId,
    gitRepository: source.gitRepository,
  });
  input.created.push(`project:${created.name}`);
  return {
    project: created,
    projectResult: {
      id: created.id,
      name: created.name,
      outcome: "created",
    },
    preferredDeploymentSource: source.source,
  };
}

function buildSetupBlockedForMissingDeployment(): VercelBridgeSetupBlocked {
  return {
    message:
      "No READY production deployment was found to redeploy after env var changes.",
    nextSteps: [
      "Deploy the project in Vercel so it has a production deployment.",
      "Return here and apply Vercel settings again.",
    ],
  };
}

function buildSetupBlockedForUnmanagedExistingProject(): VercelBridgeSetupBlocked {
  return {
    message:
      "PDev will not install the automation bridge into an existing Vercel project unless it is already marked as PDev-managed or you explicitly confirm bridge installation for that project.",
    nextSteps: [
      "Create a dedicated Vercel bridge project with Create new project.",
      "Or rerun apply with allowExistingProjectBridgeInstall after confirming this project may host the PDev bridge.",
    ],
  };
}

async function assertExistingProjectBridgeInstallAllowed(input: {
  vercelToken: string;
  projectId: string;
  teamId?: string;
  allowExistingProjectBridgeInstall?: boolean;
}): Promise<{ allowed: boolean; envVars: Awaited<ReturnType<typeof listVercelProjectEnvVars>>; setupBlocked?: VercelBridgeSetupBlocked }> {
  const envVars = await listVercelProjectEnvVars(
    input.vercelToken,
    input.projectId,
    input.teamId,
  );
  if (
    input.allowExistingProjectBridgeInstall ||
    hasPDevBridgeProjectMarker(envVars)
  ) {
    return { allowed: true, envVars };
  }
  return {
    allowed: false,
    envVars,
    setupBlocked: buildSetupBlockedForUnmanagedExistingProject(),
  };
}

async function writePDevBridgeMarker(input: {
  vercelToken: string;
  projectId: string;
  teamId?: string;
  existingEnv: Awaited<ReturnType<typeof listVercelProjectEnvVars>>;
  writtenEnvKeys: string[];
}): Promise<void> {
  const existing = input.existingEnv.find(
    (env) => env.key === PDEV_BRIDGE_PROJECT_MARKER_ENV,
  );
  if (existing) {
    return;
  }
  await upsertVercelProjectEnvVar(input.vercelToken, {
    projectId: input.projectId,
    teamId: input.teamId,
    key: PDEV_BRIDGE_PROJECT_MARKER_ENV,
    value: PDEV_BRIDGE_PROJECT_MARKER_VALUE,
  });
  input.writtenEnvKeys.push(PDEV_BRIDGE_PROJECT_MARKER_ENV);
}

function buildManualRedeployRecoveryMessage(
  redeployStatus: ProductionRedeployStatus,
  redeployMessage?: string,
): string {
  if (redeployStatus === "timeout") {
    return (
      redeployMessage ??
      "Automatic production redeploy timed out before READY. Redeploy production in Vercel, then use Apply Vercel Settings again."
    );
  }
  if (redeployStatus === "failed") {
    return (
      redeployMessage ??
      "Automatic production redeploy failed. Redeploy production in Vercel, then use Apply Vercel Settings again."
    );
  }
  return "Redeploy production in Vercel, then use Apply Vercel Settings again.";
}

async function maybeOrchestrateAutoRedeploy(input: {
  applyInput: {
    plan: VercelBridgePlanInput;
    confirmed: boolean;
    fingerprint: string;
    manualComplete?: boolean;
    cwd?: string;
  };
  baseResult: VercelBridgeApplyResult;
  signedProbe: VercelSignedProbeEvidence;
  vercelToken: string;
  projectId: string;
  projectName: string;
  teamId?: string;
  webhookUrl: string;
  fingerprint: string;
  fingerprintInputs?: VercelBridgePreviewFingerprintInputs;
  priorSelection: VercelBridgeSelection;
}): Promise<VercelBridgeApplyResult> {
  const orchestrationSteps: VercelBridgeOrchestrationStep[] = [
    {
      phase: "writing_env_vars",
      status: input.baseResult.writtenEnvKeys.length > 0 ? "completed" : "failed",
      message: "Writing Vercel env vars…",
    },
    {
      phase: "verifying_webhook",
      status: "failed",
      message: "Initial signed probe failed due to stale deployment.",
    },
  ];

  const envVarsWritten = input.baseResult.writtenEnvKeys.length > 0;
  const signedProbeInitialResult = input.signedProbe;

  if (
    !envVarsWritten ||
    !isStaleDeploymentSignatureProbeFailure(signedProbeInitialResult)
  ) {
    return {
      ...input.baseResult,
      envVarsWritten,
      signedProbeInitialResult,
      signedProbe: signedProbeInitialResult,
      productionRedeployTriggered: false,
      productionRedeployStatus: "not_triggered",
      orchestrationSteps: orchestrationSteps.slice(0, 1),
    };
  }

  const latestState = await readControlPlaneSetupState(input.applyInput.cwd);
  const existingPending =
    latestState?.vercel?.redeployVerification ??
    input.priorSelection.redeployVerification;

  if (
    existingPending?.newDeploymentId &&
    existingPending.fingerprint === input.fingerprint &&
    !["verified", "verify_failed", "failed", "timeout", "no_source_deployment"].includes(
      existingPending.status,
    )
  ) {
    orchestrationSteps.push({
      phase: "redeploying_production",
      status: "completed",
      message: "Redeploying production so new env vars take effect…",
    });

    return {
      ...input.baseResult,
      envVarsWritten,
      signedProbeInitialResult,
      signedProbe: signedProbeInitialResult,
      productionRedeployTriggered: true,
      productionRedeployStatus:
        existingPending.status === "building" ? "building" : "triggered",
      setupPending: true,
      pollActionId: existingPending.actionId,
      orchestrationSteps,
    };
  }

  const sourceDeploymentId = await findLatestReadyProductionDeploymentId({
    vercelToken: input.vercelToken,
    projectId: input.projectId,
    teamId: input.teamId,
  });

  if (
    !isAutoRedeployEligible({
      writtenEnvKeys: input.baseResult.writtenEnvKeys,
      signedProbe: signedProbeInitialResult,
      sourceDeploymentId,
    })
  ) {
    if (!sourceDeploymentId) {
      return {
        ...input.baseResult,
        envVarsWritten,
        signedProbeInitialResult,
        signedProbe: signedProbeInitialResult,
        productionRedeployTriggered: false,
        productionRedeployStatus: "no_source_deployment",
        setupBlocked: buildSetupBlockedForMissingDeployment(),
        orchestrationSteps,
      };
    }

    return {
      ...input.baseResult,
      envVarsWritten,
      signedProbeInitialResult,
      signedProbe: signedProbeInitialResult,
      productionRedeployTriggered: false,
      productionRedeployStatus: "not_triggered",
      orchestrationSteps: orchestrationSteps.slice(0, 1),
    };
  }

  const redeployResult = await triggerProductionRedeployOnce({
    vercelToken: input.vercelToken,
    projectId: input.projectId,
    projectName: input.projectName,
    teamId: input.teamId,
    sourceDeploymentId,
  });

  if (redeployResult.status !== "triggered" || !redeployResult.newDeploymentId) {
    orchestrationSteps.push({
      phase: "redeploying_production",
      status: "failed",
      message:
        redeployResult.message ??
        "Redeploying production so new env vars take effect…",
    });

    const setupBlocked =
      redeployResult.status === "no_source_deployment"
        ? buildSetupBlockedForMissingDeployment()
        : {
            message: buildManualRedeployRecoveryMessage(
              redeployResult.status,
              redeployResult.message,
            ),
            nextSteps: [
              "Redeploy production in Vercel manually if needed.",
              "Use Apply Vercel Settings again to restart verification.",
            ],
          };

    logVercelBridgeEvent({
      phase: "blocked",
      actionId: VERCEL_SETUP_ACTIONS.apply.id,
      pollStatus: redeployResult.status,
      projectId: input.projectId,
      fingerprint: input.fingerprint,
      setupBlockedMessage: setupBlocked.message,
      setupBlockedNextSteps: setupBlocked.nextSteps,
    });

    return {
      ...input.baseResult,
      envVarsWritten,
      signedProbeInitialResult,
      signedProbe: signedProbeInitialResult,
      productionRedeployTriggered: false,
      productionRedeployStatus: redeployResult.status,
      setupBlocked,
      orchestrationSteps,
    };
  }

  const pendingVerification = createPendingRedeployVerification({
    projectId: input.projectId,
    projectName: input.projectName,
    teamId: input.teamId,
    webhookUrl: input.webhookUrl,
    fingerprint: input.fingerprint,
    fingerprintInputs: input.fingerprintInputs,
    candidateSecretSource: input.baseResult.candidateSecretSource,
    sourceDeploymentId: redeployResult.sourceDeploymentId,
    newDeploymentId: redeployResult.newDeploymentId,
    message: redeployResult.message,
    writtenEnvKeys: input.baseResult.writtenEnvKeys,
    skippedEnvKeys: input.baseResult.skippedEnvKeys,
  });

  await updateControlPlaneSetupState(
    {
      vercel: {
        ...input.priorSelection,
        redeployVerification: pendingVerification,
      },
    },
    input.applyInput.cwd,
  );

  logVercelBridgeEvent({
    phase: "redeploy_trigger",
    actionId: pendingVerification.actionId,
    pollStatus: "triggered",
    projectId: input.projectId,
    projectName: input.projectName,
    teamId: input.teamId,
    fingerprint: input.fingerprint,
    candidateSecretSource: input.baseResult.candidateSecretSource,
  });

  orchestrationSteps.push({
    phase: "redeploying_production",
    status: "completed",
    message: "Redeploying production so new env vars take effect…",
  });

  return {
    ...input.baseResult,
    envVarsWritten,
    signedProbeInitialResult,
    signedProbe: signedProbeInitialResult,
    productionRedeployTriggered: true,
    productionRedeployStatus: "triggered",
    setupPending: true,
    pollActionId: pendingVerification.actionId,
    orchestrationSteps,
  };
}

export async function applyVercelBridgeSetup(input: {
  plan: VercelBridgePlanInput;
  confirmed: boolean;
  fingerprint: string;
  manualComplete?: boolean;
  verifyOnly?: boolean;
  cwd?: string;
}): Promise<VercelBridgeApplyResult> {
  assertRemoteSetupConfirmed(input.confirmed);
  assertRemoteSetupPermissionScope(
    VERCEL_SETUP_ACTIONS.apply.permission.scope,
    SETUP_PERMISSIONS.remoteSecretWrite.scope,
  );

  const normalized = normalizeVercelBridgePlanInput(input.plan);
  logVercelBridgeEvent({
    phase: "apply_start",
    actionId: VERCEL_SETUP_ACTIONS.apply.id,
    verifyOnly: input.verifyOnly === true,
    fingerprint: input.fingerprint,
    projectId: normalized.projectId,
    projectName: normalized.projectName,
    teamId: normalized.teamId,
  });
  const initialPreview = await previewVercelBridgeSetup(normalized);
  assertRemoteSetupFingerprint(input.fingerprint, initialPreview.fingerprint);
  if (initialPreview.validationError) {
    throw new Error(initialPreview.validationError);
  }

  if (input.verifyOnly !== true) {
    const githubToken = await loadSecretFromEnvLocal({
      cwd: input.cwd,
      key: "GITHUB_TOKEN",
    });
    const dispatchEligibility = await assessGitHubDispatchTokenEligibility({
      githubToken,
      cwd: input.cwd,
      verifiedDispatchRepo: normalized.derivedGithubDispatchRepository,
      requireVerifiedPackagedDispatchRepo: true,
    });
    if (!dispatchEligibility.eligible) {
      logVercelBridgeEvent({
        phase: "blocked",
        actionId: VERCEL_SETUP_ACTIONS.apply.id,
        setupBlockedMessage: dispatchEligibility.message,
        fingerprint: input.fingerprint,
      });
      return {
        actionId: VERCEL_SETUP_ACTIONS.apply.id,
        status: "applied",
        projectId: normalized.projectId ?? "",
        projectName: normalized.projectName ?? "",
        writtenEnvKeys: [],
        skippedEnvKeys: [],
        linearWebhookSetup: {
          mode: "manual-copy",
          manualSteps: [],
        },
        signedProbeVerified: false,
        deploymentRedeployRequired: false,
        verified: false,
        fingerprint: initialPreview.fingerprint,
        permission: VERCEL_SETUP_ACTIONS.apply.permission,
        setupBlocked: {
          message: dispatchEligibility.message,
          nextSteps: [
            "Update GITHUB_TOKEN in Step 1 with Contents write access to the harness dispatch repository.",
          ],
        },
      };
    }
  }

  const created: string[] = [];
  const reused: string[] = [];
  const resolvedTeam = await resolveVercelTeamForApply({
    plan: normalized,
    created,
    reused,
  });

  const resolvedProject = await resolveVercelProjectForApply({
    plan: {
      ...normalized,
      teamId: resolvedTeam.teamId,
      projectId:
        normalized.project?.mode === "existing"
          ? (normalized.projectId ?? normalized.project?.projectId)
          : undefined,
    },
    teamId: resolvedTeam.teamId,
    created,
    reused,
  });

  const planForApply: VercelBridgePlanInput = {
    ...normalized,
    teamId: resolvedTeam.teamId,
    projectId: resolvedProject.project.id,
    projectName: resolvedProject.project.name,
    team: {
      mode: "existing",
      teamId: resolvedTeam.teamId ?? "",
    },
    project: {
      mode: "existing",
      projectId: resolvedProject.project.id,
      projectName: resolvedProject.project.name,
    },
  };

  let preview = await previewVercelBridgeSetup(planForApply);
  if (preview.validationError) {
    throw new Error(preview.validationError);
  }
  if (!preview.selectedProject) {
    throw new Error("Vercel project must be selected before apply.");
  }
  const projectWasCreated = resolvedProject.projectResult.outcome === "created";
  let preDeploymentWebhookSecret: string | undefined;
  let preDeploymentWrittenEnvKeys: string[] = [];
  if (!preview.webhookUrl) {
    const protection = projectWasCreated
      ? {
          allowed: true,
          envVars: await listVercelProjectEnvVars(
            normalized.vercelToken,
            preview.selectedProject.id,
            resolvedTeam.teamId,
          ),
          setupBlocked: undefined,
        }
      : await assertExistingProjectBridgeInstallAllowed({
          vercelToken: normalized.vercelToken,
          projectId: preview.selectedProject.id,
          teamId: resolvedTeam.teamId,
          allowExistingProjectBridgeInstall:
            normalized.allowExistingProjectBridgeInstall,
        });

    if (!protection.allowed) {
      logVercelBridgeEvent({
        phase: "blocked",
        actionId: VERCEL_SETUP_ACTIONS.apply.id,
        projectId: preview.selectedProject.id,
        projectName: preview.selectedProject.name,
        fingerprint: preview.fingerprint,
        setupBlockedMessage: protection.setupBlocked?.message,
        setupBlockedNextSteps: protection.setupBlocked?.nextSteps,
      });
      return {
        actionId: VERCEL_SETUP_ACTIONS.apply.id,
        status: "applied",
        projectId: preview.selectedProject.id,
        projectName: preview.selectedProject.name,
        team: resolvedTeam.team,
        project: resolvedProject.projectResult,
        writtenEnvKeys: [],
        skippedEnvKeys: [],
        linearWebhookSetup: {
          mode: "manual-copy",
          manualSteps: protection.setupBlocked?.nextSteps ?? [],
        },
        verified: false,
        signedProbeVerified: false,
        deploymentRedeployRequired: false,
        fingerprint: preview.fingerprint,
        permission: VERCEL_SETUP_ACTIONS.apply.permission,
        setupBlocked: protection.setupBlocked,
      };
    }

    preDeploymentWebhookSecret =
      normalized.envInput?.LINEAR_WEBHOOK_SECRET?.trim() ??
      generateLinearWebhookSecret();
    if (!normalized.envInput?.LINEAR_WEBHOOK_SECRET?.trim()) {
      await persistGeneratedLinearWebhookSecret({
        cwd: input.cwd,
        secret: preDeploymentWebhookSecret,
      });
    }

    const existingByKey = new Map(protection.envVars.map((env) => [env.key, env]));
    const skippedEnvKeys: string[] = [];
    for (const entry of preview.envWritePlan) {
      if (entry.action === "skip") {
        skippedEnvKeys.push(entry.key);
        continue;
      }
      const value = resolveVercelBridgeEnvValue({
        key: entry.key,
        envInput: normalized.envInput,
        derivedHarnessTeamKey: normalized.derivedHarnessTeamKey,
        derivedGithubDispatchToken: normalized.derivedGithubDispatchToken,
        derivedGithubDispatchRepository: normalized.derivedGithubDispatchRepository,
        generatedLinearWebhookSecret: preDeploymentWebhookSecret,
      });
      if (!value?.trim()) {
        skippedEnvKeys.push(entry.key);
        continue;
      }
      await upsertVercelProjectEnvVar(normalized.vercelToken, {
        projectId: preview.selectedProject.id,
        teamId: resolvedTeam.teamId,
        key: entry.key,
        value: value.trim(),
        existingEnv: existingByKey.get(entry.key),
      });
      preDeploymentWrittenEnvKeys.push(entry.key);
    }
    await writePDevBridgeMarker({
      vercelToken: normalized.vercelToken,
      projectId: preview.selectedProject.id,
      teamId: resolvedTeam.teamId,
      existingEnv: protection.envVars,
      writtenEnvKeys: preDeploymentWrittenEnvKeys,
    });

    const deployment = await deployVercelBridgeProduction({
      vercelToken: normalized.vercelToken,
      projectName: preview.selectedProject.name,
      teamId: resolvedTeam.teamId,
      preferredSource: resolvedProject.preferredDeploymentSource,
    });

    if (deployment.status !== "ready" || !deployment.deploymentId) {
      return {
        actionId: VERCEL_SETUP_ACTIONS.apply.id,
        status: "applied",
        projectId: preview.selectedProject.id,
        projectName: preview.selectedProject.name,
        team: resolvedTeam.team,
        project: resolvedProject.projectResult,
        writtenEnvKeys: preDeploymentWrittenEnvKeys,
        skippedEnvKeys,
        linearWebhookSetup: {
          mode: "manual-copy",
          manualSteps: [
            deployment.message ??
              "Vercel bridge deployment did not reach READY before verification.",
          ],
        },
        verified: false,
        signedProbeVerified: false,
        deploymentRedeployRequired: false,
        productionRedeployStatus:
          deployment.status === "timeout" ? "timeout" : "failed",
        fingerprint: preview.fingerprint,
        permission: VERCEL_SETUP_ACTIONS.apply.permission,
        setupBlocked: {
          message:
            deployment.message ??
            "Vercel bridge deployment did not reach READY before verification.",
          nextSteps: [
            "Check the Vercel deployment logs for the bridge project.",
            "Apply Vercel settings again after the deployment reaches READY.",
          ],
        },
        orchestrationSteps: [
          {
            phase: "writing_env_vars",
            status: "completed",
            message: "Writing Vercel env vars before deployment.",
          },
          {
            phase: "deploying_bridge",
            status: "failed",
            message:
              deployment.message ??
              "Creating the production bridge deployment failed.",
          },
        ],
      };
    }

    const productionTarget = await resolveCanonicalProductionTarget({
      vercelToken: normalized.vercelToken,
      projectId: preview.selectedProject.id,
      teamId: resolvedTeam.teamId,
      preferredDeploymentId: deployment.deploymentId,
    });
    if (!productionTarget?.webhookUrl) {
      throw new Error("Vercel bridge deployment reached READY but no production URL was resolved.");
    }
    const endpoint = await checkWebhookEndpointReachable(productionTarget.webhookUrl);
    preview = {
      ...preview,
      productionUrl: productionTarget.productionUrl,
      webhookUrl: productionTarget.webhookUrl,
      productionUrlSource: productionTarget.source,
      canonicalDeploymentId: productionTarget.deploymentId,
      deploymentStatus: "ready",
      endpointReachable: endpoint.reachable,
      endpointStatusCode: endpoint.statusCode,
      deploymentRequired: undefined,
    };
  }

  if (!preview.webhookUrl) {
    const selectedProjectForDeploymentRequired = preview.selectedProject;
    if (!selectedProjectForDeploymentRequired) {
      throw new Error("Vercel project must be selected before apply.");
    }
    const projectJustCreated = projectWasCreated;
    const deploymentRequired = buildDeploymentRequiredDetail({
      projectName: selectedProjectForDeploymentRequired.name,
      projectJustCreated,
    });

    return {
      actionId: VERCEL_SETUP_ACTIONS.apply.id,
      status: "deployment-required",
      projectId: selectedProjectForDeploymentRequired.id,
      projectName: selectedProjectForDeploymentRequired.name,
      team: resolvedTeam.team,
      project: resolvedProject.projectResult,
      writtenEnvKeys: [],
      skippedEnvKeys: [],
      linearWebhookSetup: {
        mode: "manual-copy",
        manualSteps: deploymentRequired.nextSteps,
      },
      deploymentRequired: {
        ...deploymentRequired,
        projectJustCreated,
      },
      verified: false,
      signedProbeVerified: false,
      deploymentRedeployRequired: false,
      fingerprint: preview.fingerprint,
      permission: VERCEL_SETUP_ACTIONS.apply.permission,
    };
  }

  const selectedProject = preview.selectedProject;
  if (!selectedProject) {
    throw new Error("Vercel project must be selected before apply.");
  }

  const priorState = await readControlPlaneSetupState(input.cwd);
  const activePendingRedeploy = Boolean(
    priorState?.vercel?.redeployVerification?.newDeploymentId &&
      priorState.vercel.redeployVerification.status !== "verified" &&
      priorState.vercel.redeployVerification.status !== "verify_failed" &&
      priorState.vercel.redeployVerification.status !== "failed" &&
      priorState.vercel.redeployVerification.status !== "timeout" &&
      priorState.vercel.redeployVerification.status !== "no_source_deployment",
  );
  const isVerificationRetry =
    input.verifyOnly === true ||
    Boolean(
      !activePendingRedeploy &&
        priorState?.vercel?.deploymentRedeployRequired &&
        priorState.vercel.projectId === selectedProject.id &&
        priorState.vercel.appliedFingerprint === preview.fingerprint,
    );
  const persistedWebhookUrl = priorState?.vercel?.webhookUrl?.trim();
  const canonicalWebhookUrl = preview.webhookUrl?.trim();
  const hasWebhookUrlDrift = Boolean(
    isVerificationRetry &&
      persistedWebhookUrl &&
      canonicalWebhookUrl &&
      persistedWebhookUrl !== canonicalWebhookUrl,
  );

  const candidateResolution = await resolveLinearWebhookCandidateSecret({
    linearApiKey: normalized.linearApiKey,
    webhookUrl: preview.webhookUrl,
    linearTeamId: normalized.linearTeamId,
    operatorSecret: normalized.envInput?.LINEAR_WEBHOOK_SECRET,
  });

  const savedVerificationSecret = normalized.verificationLinearWebhookSecret?.trim();
  const useSavedVerificationSecret = Boolean(
    savedVerificationSecret &&
      (isVerificationRetry || normalized.preserveGeneratedWebhookSecretFingerprint),
  );

  let candidateWebhookSecret = preDeploymentWebhookSecret ?? candidateResolution.secret;
  if (useSavedVerificationSecret) {
    candidateWebhookSecret = savedVerificationSecret;
  } else if (
    !preDeploymentWebhookSecret &&
    !candidateWebhookSecret?.trim() &&
    candidateResolution.source === "generated"
  ) {
    candidateWebhookSecret = generateLinearWebhookSecret();
  }
  if (
    !preDeploymentWebhookSecret &&
    candidateResolution.source === "unreadable" &&
    !isVerificationRetry &&
    !candidateWebhookSecret?.trim()
  ) {
    candidateWebhookSecret = generateLinearWebhookSecret();
  }

  if (
    !isVerificationRetry &&
    !preDeploymentWebhookSecret &&
    candidateWebhookSecret?.trim() &&
    !useSavedVerificationSecret &&
    (candidateResolution.source === "generated" ||
      candidateResolution.source === "unreadable")
  ) {
    await persistGeneratedLinearWebhookSecret({
      cwd: input.cwd,
      secret: candidateWebhookSecret,
    });
  }

  let linearWebhookSetup: VercelBridgeLinearWebhookSetupResult = {
    mode: "manual-copy",
    manualSteps: candidateResolution.manualSteps,
    manualCopySecret: undefined,
  };
  let webhookUrlReconciliation: LinearWebhookUrlReconciliationResult | undefined;

  if (
    hasWebhookUrlDrift &&
    candidateWebhookSecret?.trim() &&
    useSavedVerificationSecret &&
    normalized.linearApiKey?.trim()
  ) {
    webhookUrlReconciliation = await reconcileLinearWebhookUrlForVerification({
      linearApiKey: normalized.linearApiKey,
      linearTeamId: normalized.linearTeamId,
      previousWebhookUrl: persistedWebhookUrl!,
      canonicalWebhookUrl: canonicalWebhookUrl!,
      secret: candidateWebhookSecret,
    });
    logVercelBridgeEvent({
      phase: "linear_webhook_url_reconcile",
      actionId: VERCEL_SETUP_ACTIONS.apply.id,
      verifyOnly: input.verifyOnly === true,
      projectId: selectedProject.id,
      fingerprint: preview.fingerprint,
      webhookUrlDrift: true,
      reconciliationAttempted: webhookUrlReconciliation.attempted,
      reconciliationSucceeded: webhookUrlReconciliation.reconciled,
      matchingPreviousWebhookFound:
        webhookUrlReconciliation.matchingPreviousWebhookFound,
      canonicalWebhookExists: webhookUrlReconciliation.canonicalWebhookExists,
    });
  }

  if (
    candidateResolution.source === "unreadable" &&
    isVerificationRetry
  ) {
    linearWebhookSetup = {
      mode: "existing-unverified",
      manualSteps: candidateResolution.manualSteps,
      manualCopySecret: undefined,
    };
  } else if (
    webhookUrlReconciliation?.attempted &&
    !webhookUrlReconciliation.reconciled
  ) {
    linearWebhookSetup = {
      mode: "existing-unverified",
      manualSteps: webhookUrlReconciliation.manualSteps,
      manualCopySecret: undefined,
    };
  } else if (!candidateWebhookSecret?.trim()) {
    linearWebhookSetup = {
      mode: "manual-copy",
      manualSteps: candidateResolution.manualSteps,
      manualCopySecret: undefined,
    };
  } else if (normalized.linearApiKey?.trim()) {
    const ensured = await ensureLinearIssueWebhook({
      linearApiKey: normalized.linearApiKey,
      webhookUrl: preview.webhookUrl,
      linearTeamId: normalized.linearTeamId,
      secret: candidateWebhookSecret,
      mutatePolicy: isVerificationRetry ? "verify-only" : "setup",
    });
    linearWebhookSetup = {
      mode: ensured.mode,
      manualSteps: ensured.manualSteps,
      manualCopySecret:
        ensured.mode === "automated" ? undefined : ensured.secret,
    };
    if (!useSavedVerificationSecret) {
      candidateWebhookSecret = ensured.secret;
    }
  } else {
    linearWebhookSetup = {
      mode: "manual-copy",
      manualSteps: [
        "Add LINEAR_API_KEY in Step 1 before automated Linear webhook setup can run.",
        "Copy the generated webhook secret into Linear when prompted.",
      ],
      manualCopySecret: candidateWebhookSecret,
    };
  }

  const knownSecrets = collectRemoteSecretInputs({
    linearApiKey: normalized.linearApiKey,
    githubToken:
      normalized.envInput?.GITHUB_DISPATCH_TOKEN ??
      normalized.derivedGithubDispatchToken,
  });
  if (candidateWebhookSecret?.trim()) {
    knownSecrets.push(candidateWebhookSecret);
  }
  if (normalized.envInput?.GITHUB_DISPATCH_TOKEN) {
    knownSecrets.push(normalized.envInput.GITHUB_DISPATCH_TOKEN);
  }
  if (normalized.derivedGithubDispatchToken) {
    knownSecrets.push(normalized.derivedGithubDispatchToken);
  }

  const existingEnv = await listVercelProjectEnvVars(
    normalized.vercelToken,
    selectedProject.id,
    resolvedTeam.teamId,
  );
  const existingByKey = new Map(existingEnv.map((env) => [env.key, env]));
  const shouldWriteWebhookSecret =
    !isVerificationRetry && Boolean(candidateWebhookSecret?.trim());

  const writtenEnvKeys: string[] = [...preDeploymentWrittenEnvKeys];
  const skippedEnvKeys: string[] = [];

  for (const entry of preview.envWritePlan) {
    if (preDeploymentWrittenEnvKeys.includes(entry.key)) {
      skippedEnvKeys.push(entry.key);
      continue;
    }
    if (entry.action === "skip") {
      skippedEnvKeys.push(entry.key);
      continue;
    }

    if (entry.key === "LINEAR_WEBHOOK_SECRET" && !shouldWriteWebhookSecret) {
      skippedEnvKeys.push(entry.key);
      continue;
    }

    const value = resolveVercelBridgeEnvValue({
      key: entry.key,
      envInput: normalized.envInput,
      derivedHarnessTeamKey: normalized.derivedHarnessTeamKey,
      derivedGithubDispatchToken: normalized.derivedGithubDispatchToken,
      derivedGithubDispatchRepository: normalized.derivedGithubDispatchRepository,
      generatedLinearWebhookSecret: candidateWebhookSecret,
    });

    if (!value?.trim()) {
      skippedEnvKeys.push(entry.key);
      continue;
    }

    const existing = existingByKey.get(entry.key);
    try {
      await upsertVercelProjectEnvVar(normalized.vercelToken, {
        projectId: selectedProject.id,
        teamId: resolvedTeam.teamId,
        key: entry.key,
        value: value.trim(),
        existingEnv: existing,
      });
    } catch (error) {
      if (error instanceof VercelEnvVarTypeError) {
        throw error;
      }
      throw error;
    }
    writtenEnvKeys.push(entry.key);
  }

  if (
    shouldWriteWebhookSecret &&
    !writtenEnvKeys.includes("LINEAR_WEBHOOK_SECRET") &&
    candidateWebhookSecret?.trim()
  ) {
    const existing = existingByKey.get("LINEAR_WEBHOOK_SECRET");
    await upsertVercelProjectEnvVar(normalized.vercelToken, {
      projectId: selectedProject.id,
      teamId: resolvedTeam.teamId,
      key: "LINEAR_WEBHOOK_SECRET",
      value: candidateWebhookSecret,
      existingEnv: existing,
    });
    writtenEnvKeys.push("LINEAR_WEBHOOK_SECRET");
  }

  const postWriteEnv = await listVercelProjectEnvVars(
    normalized.vercelToken,
    selectedProject.id,
    resolvedTeam.teamId,
  );
  const requiredEnvPresence = summarizeRequiredEnvPresence(postWriteEnv);

  let linearWebhookVerified = false;
  if (normalized.linearApiKey?.trim()) {
    const webhookSummary = await summarizeLinearWebhookReadiness({
      linearApiKey: normalized.linearApiKey,
      webhookUrl: preview.webhookUrl,
      teamId: normalized.linearTeamId,
    });
    linearWebhookVerified =
      linearWebhookSetup.mode === "automated" &&
      Boolean(webhookSummary.matchingWebhook);
  }

  const verificationFingerprint = buildVercelBridgeVerificationFingerprint({
    projectId: selectedProject.id,
    linearTeamId: normalized.linearTeamId,
    productionUrl: preview.productionUrl,
    webhookUrl: preview.webhookUrl,
    envWritePlan: preview.envWritePlan,
    candidateSecretToken: tokenizeCandidateWebhookSecret(
      candidateWebhookSecret,
    ),
  });

  const signedProbe = candidateWebhookSecret?.trim()
    ? await runSignedWebhookProbe({
        webhookUrl: preview.webhookUrl,
        secret: candidateWebhookSecret,
      })
    : {
        passed: false,
        result: "error" as const,
        reason: "missing_candidate_secret",
        probedAt: new Date().toISOString(),
      };
  const signedProbeVerified = signedProbe.passed;
  const deploymentRedeployRequired =
    writtenEnvKeys.length > 0 && !signedProbeVerified;

  logVercelBridgeEvent({
    phase: "signed_probe",
    actionId: VERCEL_SETUP_ACTIONS.apply.id,
    verifyOnly: input.verifyOnly === true,
    projectId: selectedProject.id,
    projectName: selectedProject.name,
    teamId: resolvedTeam.teamId,
    fingerprint: preview.fingerprint,
    candidateSecretSource: candidateResolution.source,
    hasLocalWebhookSecret: Boolean(
      normalized.verificationLinearWebhookSecret?.trim() ||
        normalized.envInput?.LINEAR_WEBHOOK_SECRET?.trim(),
    ),
    envWritePlan: preview.envWritePlan.map((entry) => ({
      key: entry.key,
      action: entry.action,
      source: entry.source,
    })),
    signedProbeResult: signedProbe.result,
    signedProbeReason: signedProbe.reason,
    signedProbeStatusCode: signedProbe.statusCode,
  });

  const verified =
    REQUIRED_VERCEL_BRIDGE_ENV_VARS.every(
      (key) => requiredEnvPresence[key] === "present",
    ) &&
    preview.endpointReachable &&
    linearWebhookVerified &&
    signedProbeVerified &&
    !deploymentRedeployRequired;

  const selection: VercelBridgeSelection = {
    teamId: resolvedTeam.teamId,
    teamName: resolvedTeam.teamName,
    projectId: selectedProject.id,
    projectName: selectedProject.name,
    productionUrl: preview.productionUrl ?? "",
    webhookUrl: preview.webhookUrl ?? "",
    endpointReachable: preview.endpointReachable,
    envVarPresence: requiredEnvPresence,
    linearWebhookVerified,
    signedProbeVerified,
    signedProbe,
    verificationFingerprint,
    deploymentRedeployRequired,
    appliedFingerprint: preview.fingerprint,
    appliedAt: new Date().toISOString(),
    manualComplete: input.manualComplete,
  };

  await updateControlPlaneSetupState(
    {
      vercel: selection,
    },
    input.cwd,
  );

  const resultPayload = {
    actionId: VERCEL_SETUP_ACTIONS.apply.id,
    writtenEnvKeys,
    skippedEnvKeys,
    linearWebhookSetup: {
      mode: linearWebhookSetup.mode,
      manualSteps: linearWebhookSetup.manualSteps,
    },
    signedProbeVerified,
    verified,
  };
  const serialized = JSON.stringify(resultPayload);
  for (const secret of knownSecrets) {
    if (serialized.includes(secret)) {
      throw new Error("Vercel bridge apply result leaked secret material");
    }
  }

  const baseResult: VercelBridgeApplyResult = {
    actionId: VERCEL_SETUP_ACTIONS.apply.id,
    status: "applied",
    projectId: selectedProject.id,
    projectName: selectedProject.name,
    team: resolvedTeam.team,
    project: resolvedProject.projectResult,
    writtenEnvKeys,
    skippedEnvKeys,
    linearWebhookSetup,
    signedProbeVerified,
    signedProbeReason: signedProbe.reason,
    signedProbe,
    deploymentRedeployRequired,
    verificationRetry: isVerificationRetry,
    candidateSecretSource: candidateResolution.source,
    verified,
    fingerprint: preview.fingerprint,
    permission: VERCEL_SETUP_ACTIONS.apply.permission,
    envVarsWritten: writtenEnvKeys.length > 0,
    productionRedeployTriggered: false,
    productionRedeployStatus: "not_triggered",
  };

  if (
    input.verifyOnly ||
    isVerificationRetry ||
    !deploymentRedeployRequired ||
    baseResult.verified
  ) {
    logVercelBridgeEvent({
      phase: "apply_complete",
      actionId: VERCEL_SETUP_ACTIONS.apply.id,
      verifyOnly: input.verifyOnly === true,
      projectId: selectedProject.id,
      projectName: selectedProject.name,
      teamId: resolvedTeam.teamId,
      fingerprint: preview.fingerprint,
      signedProbeResult: signedProbe.result,
      signedProbeReason: signedProbe.reason,
      pollStatus: baseResult.verified ? "verified" : undefined,
    });
    return baseResult;
  }

  logVercelBridgeEvent({
    phase: "redeploy_trigger",
    actionId: VERCEL_SETUP_ACTIONS.apply.id,
    projectId: selectedProject.id,
    projectName: selectedProject.name,
    teamId: resolvedTeam.teamId,
    fingerprint: preview.fingerprint,
    candidateSecretSource: candidateResolution.source,
    signedProbeResult: signedProbe.result,
    signedProbeReason: signedProbe.reason,
  });

  return maybeOrchestrateAutoRedeploy({
    applyInput: input,
    baseResult,
    signedProbe,
    vercelToken: normalized.vercelToken,
    projectId: selectedProject.id,
    projectName: selectedProject.name,
    teamId: resolvedTeam.teamId,
    webhookUrl: preview.webhookUrl ?? "",
    fingerprint: preview.fingerprint,
    fingerprintInputs: buildVercelBridgePreviewFingerprintInput({
      teamId: resolvedTeam.teamId,
      teamMode: planForApply.team?.mode,
      teamSlug: planForApply.team?.teamSlug,
      projectId: selectedProject.id,
      projectMode: planForApply.project?.mode,
      projectName: planForApply.project?.projectName,
      envWritePlan: preview.envWritePlan,
      willGenerateLinearWebhookSecret:
        planForApply.willGenerateLinearWebhookSecret ??
        !planForApply.envInput?.LINEAR_WEBHOOK_SECRET?.trim(),
      linearWebhookSecretFromEnv: planForApply.envInput?.LINEAR_WEBHOOK_SECRET,
      githubDispatchTokenFromEnv: planForApply.envInput?.GITHUB_DISPATCH_TOKEN,
      derivedGithubDispatchToken: planForApply.derivedGithubDispatchToken,
      harnessTeamKey: planForApply.envInput?.HARNESS_TEAM_KEY,
      derivedHarnessTeamKey: planForApply.derivedHarnessTeamKey,
      vercelToken: normalized.vercelToken,
      allowExistingProjectBridgeInstall:
        planForApply.allowExistingProjectBridgeInstall,
    }),
    priorSelection: selection,
  });
}

export type { VercelBridgePlanInput, VercelBridgePreview };
