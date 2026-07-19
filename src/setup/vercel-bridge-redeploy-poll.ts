import {
  readControlPlaneSetupState,
  updateControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import { withControlPlaneStateLock } from "./control-plane-state-lock.js";
import type {
  ControlPlaneSetupState,
  VercelBridgeOrchestrationPhase,
  VercelBridgeRedeployVerification,
  VercelBridgeRedeployVerificationStatus,
  VercelBridgeSelection,
  VercelSignedProbeEvidence,
} from "./control-plane-types.js";
import { assessGitHubDispatchTokenEligibility } from "./github-dispatch-token.js";
import { inspectProductionRedeployStatus } from "./vercel-production-redeploy.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";
import { loadSecretFromEnvLocal } from "./service-verification.js";
import {
  applyVercelBridgeSetup,
  type VercelBridgeApplyResult,
  type VercelBridgeOrchestrationStep,
  type VercelBridgePlanInput,
  type VercelBridgeSetupBlocked,
} from "./vercel-setup-apply.js";
import {
  buildVercelBridgePreviewFingerprintInput,
  isAcceptableRedeployFingerprintDrift,
  normalizeVercelBridgePlanInput,
  previewVercelBridgeSetup,
} from "./vercel-setup-plan.js";
import { logVercelBridgeEvent } from "./vercel-bridge-structured-log.js";
import { deriveHarnessTeamKeyFromControlPlane } from "./derive-harness-team-key.js";
import {
  buildVerificationClaim,
  classifySignedProbeFailure,
  DEFAULT_MAX_VERIFICATION_ATTEMPTS,
  getOrchestrationStatusMessage,
  isOrchestrationActive,
  isTerminalRedeployVerificationStatus,
  isVerificationAttemptDue,
  getVerificationAttemptNotDueReason,
  mapPendingPhaseForDeployStatus,
  normalizeRedeployVerification,
  VERIFICATION_POLL_INTERVAL_MS,
} from "./vercel-bridge-redeploy-normalize.js";

function buildPersistedContextMismatchBlocked(): VercelBridgeSetupBlocked {
  return {
    message:
      "Persisted Step 3 setup context no longer matches the in-progress redeploy verification.",
    nextSteps: [
      "Use Apply Vercel Settings again to regenerate preview and restart verification.",
      "If the problem persists, confirm team and project selections match the original apply.",
    ],
  };
}

function buildMissingPollCredentialsBlocked(missing: string): VercelBridgeSetupBlocked {
  return {
    message: `Cannot resume redeploy verification because ${missing} is missing from saved setup.`,
    nextSteps: [
      "Return to Step 1 and save the required token in .env.local.",
      "Then use Apply Vercel Settings again to restart verification.",
    ],
  };
}

export async function buildPollVerifyPlanInputFromPersistedState(input: {
  cwd?: string;
  state: ControlPlaneSetupState;
  pending: VercelBridgeRedeployVerification;
}): Promise<
  | { ok: true; plan: VercelBridgePlanInput; vercelToken: string }
  | { ok: false; setupBlocked: VercelBridgeSetupBlocked }
> {
  const vercel = input.state.vercel;
  if (!vercel) {
    return {
      ok: false,
      setupBlocked: buildMissingPollCredentialsBlocked("saved Vercel selection"),
    };
  }

  const vercelToken = (await loadSecretFromEnvLocal({ cwd: input.cwd, key: "VERCEL_TOKEN" })) ?? "";
  if (!vercelToken.trim()) {
    return {
      ok: false,
      setupBlocked: buildMissingPollCredentialsBlocked("VERCEL_TOKEN"),
    };
  }

  const linearApiKey = await loadSecretFromEnvLocal({ cwd: input.cwd, key: "LINEAR_API_KEY" });
  const githubToken = await loadSecretFromEnvLocal({ cwd: input.cwd, key: "GITHUB_TOKEN" });
  const dispatchEligibility = await assessGitHubDispatchTokenEligibility({
    githubToken,
    cwd: input.cwd,
  });

  const teamId = input.pending.teamId ?? vercel.teamId;
  const projectId = input.pending.projectId;
  const projectName = input.pending.projectName;
  const linearTeamId =
    input.state.linearWorkspace?.teams[0]?.teamId ??
    input.state.linear?.teamId;
  const derivedHarnessTeamKey =
    input.pending.fingerprintInputs?.harnessTeamKey?.trim() ||
    deriveHarnessTeamKeyFromControlPlane(input.state);

  const savedWebhookSecret = await loadSecretFromEnvLocal({
    cwd: input.cwd,
    key: "LINEAR_WEBHOOK_SECRET",
  });
  const preserveGeneratedFingerprint =
    input.pending.candidateSecretSource === "generated" ||
    input.pending.candidateSecretSource === "unreadable" ||
    Boolean(savedWebhookSecret?.trim());

  const plan = normalizeVercelBridgePlanInput({
    vercelToken,
    linearApiKey,
    teamId,
    projectId,
    projectName,
    preferredProductionDeploymentId: input.pending.newDeploymentId,
    team: {
      mode: "existing",
      teamId: teamId ?? "",
    },
    project: {
      mode: "existing",
      projectId,
      projectName,
    },
    linearTeamId,
    derivedHarnessTeamKey,
    derivedGithubDispatchToken:
      dispatchEligibility.eligible && githubToken ? githubToken : undefined,
    willGenerateLinearWebhookSecret: preserveGeneratedFingerprint
      ? true
      : !savedWebhookSecret?.trim(),
    verificationLinearWebhookSecret: savedWebhookSecret,
    preserveGeneratedWebhookSecretFingerprint: preserveGeneratedFingerprint,
    allowExistingProjectBridgeInstall: true,
  });

  return { ok: true, plan, vercelToken };
}

function pollFingerprintAcceptable(input: {
  pending: VercelBridgeRedeployVerification;
  plan: VercelBridgePlanInput;
  preview: Awaited<ReturnType<typeof previewVercelBridgeSetup>>;
  vercelToken: string;
}): boolean {
  if (input.preview.fingerprint === input.pending.fingerprint) {
    return true;
  }
  const original = input.pending.fingerprintInputs;
  if (!original) {
    return false;
  }
  const normalized = normalizeVercelBridgePlanInput(input.plan);
  const reconstructed = buildVercelBridgePreviewFingerprintInput({
    teamId: input.pending.teamId ?? normalized.teamId,
    teamMode: normalized.team?.mode,
    teamSlug: normalized.team?.teamSlug,
    projectId: input.pending.projectId,
    projectMode: normalized.project?.mode,
    projectName: input.pending.projectName,
    envWritePlan: input.preview.envWritePlan,
    willGenerateLinearWebhookSecret:
      normalized.willGenerateLinearWebhookSecret ??
      !normalized.envInput?.LINEAR_WEBHOOK_SECRET?.trim(),
    linearWebhookSecretFromEnv: normalized.envInput?.LINEAR_WEBHOOK_SECRET,
    githubDispatchTokenFromEnv: normalized.envInput?.GITHUB_DISPATCH_TOKEN,
    derivedGithubDispatchToken: normalized.derivedGithubDispatchToken,
    harnessTeamKey: normalized.envInput?.HARNESS_TEAM_KEY,
    derivedHarnessTeamKey: normalized.derivedHarnessTeamKey,
    vercelToken: input.vercelToken,
    allowExistingProjectBridgeInstall:
      normalized.allowExistingProjectBridgeInstall,
  });
  return isAcceptableRedeployFingerprintDrift({
    original,
    reconstructed,
  });
}

export async function reconstructPollVerifyPreviewForDiagnostics(input: {
  cwd?: string;
  state: ControlPlaneSetupState;
  pending: VercelBridgeRedeployVerification;
}): Promise<
  | {
      ok: true;
      plan: VercelBridgePlanInput;
      vercelToken: string;
      preview: Awaited<ReturnType<typeof previewVercelBridgeSetup>>;
      fingerprintMatch: boolean;
    }
  | { ok: false; setupBlocked: VercelBridgeSetupBlocked }
> {
  const built = await buildPollVerifyPlanInputFromPersistedState(input);
  if (!built.ok) {
    return built;
  }

  const preview = await previewVercelBridgeSetup(built.plan);
  const fingerprintMatch = pollFingerprintAcceptable({
    pending: input.pending,
    plan: built.plan,
    preview,
    vercelToken: built.vercelToken,
  });
  return {
    ok: true,
    plan: built.plan,
    vercelToken: built.vercelToken,
    preview,
    fingerprintMatch,
  };
}

export async function buildPollVerifyPlanFromPersistedState(input: {
  cwd?: string;
  state: ControlPlaneSetupState;
  pending: VercelBridgeRedeployVerification;
}): Promise<
  | {
      ok: true;
      plan: VercelBridgePlanInput;
      vercelToken: string;
      /** Fingerprint for verify-only apply after acceptable post-write drift. */
      applyFingerprint: string;
    }
  | { ok: false; setupBlocked: VercelBridgeSetupBlocked }
> {
  const built = await buildPollVerifyPlanInputFromPersistedState(input);
  if (!built.ok) {
    return built;
  }

  const preview = await previewVercelBridgeSetup(built.plan);
  const fingerprintMatch = pollFingerprintAcceptable({
    pending: input.pending,
    plan: built.plan,
    preview,
    vercelToken: built.vercelToken,
  });
  if (!fingerprintMatch) {
    logVercelBridgeEvent({
      phase: "poll_reconstruct",
      actionId: input.pending.actionId,
      expectedFingerprint: input.pending.fingerprint,
      reconstructedFingerprint: preview.fingerprint,
      fingerprintMatch: false,
      projectId: input.pending.projectId,
      projectName: input.pending.projectName,
      teamId: input.pending.teamId,
    });
    return {
      ok: false,
      setupBlocked: buildPersistedContextMismatchBlocked(),
    };
  }

  if (preview.fingerprint !== input.pending.fingerprint) {
    logVercelBridgeEvent({
      phase: "poll_reconstruct",
      actionId: input.pending.actionId,
      expectedFingerprint: input.pending.fingerprint,
      reconstructedFingerprint: preview.fingerprint,
      fingerprintMatch: true,
      projectId: input.pending.projectId,
      projectName: input.pending.projectName,
      teamId: input.pending.teamId,
    });
  }

  return {
    ok: true,
    plan: built.plan,
    vercelToken: built.vercelToken,
    applyFingerprint: preview.fingerprint,
  };
}

function buildSetupBlockedForPostRedeployVerificationFailure(input?: {
  retryReason?: string;
  exhausted?: boolean;
}): VercelBridgeSetupBlocked {
  const reasonSuffix = input?.retryReason?.trim()
    ? ` (${input.retryReason})`
    : "";
  return {
    message: input?.exhausted
      ? `Signed webhook verification failed after ${DEFAULT_MAX_VERIFICATION_ATTEMPTS} attempts${reasonSuffix}.`
      : `Production redeploy completed, but signed webhook delivery verification still failed${reasonSuffix}.`,
    nextSteps: [
      "Use Apply Vercel Settings again after confirming the Linear webhook signing secret matches Vercel production.",
      "If verification still fails, confirm the production deployment and webhook URL are correct.",
    ],
  };
}

function buildManualRedeployRecoveryMessage(
  status: VercelBridgeRedeployVerificationStatus,
  message?: string,
): string {
  if (status === "timeout") {
    return (
      message ??
      "Automatic production redeploy timed out before READY. Redeploy production in Vercel, then use Apply Vercel Settings again."
    );
  }
  if (status === "failed") {
    return (
      message ??
      "Automatic production redeploy failed. Redeploy production in Vercel, then use Apply Vercel Settings again."
    );
  }
  return "Redeploy production in Vercel, then use Apply Vercel Settings again.";
}

function mapRedeployStatusToProductionStatus(
  status: VercelBridgeRedeployVerificationStatus,
): VercelBridgeApplyResult["productionRedeployStatus"] {
  switch (status) {
    case "triggered":
      return "triggered";
    case "building":
      return "building";
    case "ready":
    case "verified":
      return "ready";
    case "failed":
      return "failed";
    case "timeout":
      return "timeout";
    case "no_source_deployment":
      return "no_source_deployment";
    case "verify_failed":
      return "ready";
    default:
      return "not_triggered";
  }
}

function buildOrchestrationSteps(input: {
  pending?: VercelBridgeRedeployVerification;
  apply?: VercelBridgeApplyResult;
}): VercelBridgeOrchestrationStep[] {
  const steps: VercelBridgeOrchestrationStep[] = [
    {
      phase: "writing_env_vars",
      status: "completed",
      message: "Writing Vercel env vars…",
    },
  ];

  if (!input.pending) {
    return steps;
  }

  const normalized = normalizeRedeployVerification({ pending: input.pending });

  if (normalized.status === "no_source_deployment") {
    steps.push({
      phase: "redeploying_production",
      status: "failed",
      message:
        normalized.message ??
        "No READY production deployment was found to redeploy after env var changes.",
    });
    return steps;
  }

  steps.push({
    phase: "redeploying_production",
    status:
      normalized.status === "failed" || normalized.status === "timeout"
        ? "failed"
        : "completed",
    message: getOrchestrationStatusMessage({
      ...normalized,
      phase:
        normalized.phase === "building" || normalized.phase === "triggered"
          ? normalized.phase
          : "waiting_for_ready",
    }),
  });

  if (
    normalized.phase === "verifying" ||
    normalized.phase === "retry_wait" ||
    normalized.status === "verify_failed" ||
    normalized.status === "verified" ||
    input.apply?.verificationRetry
  ) {
    steps.push({
      phase: "verifying_webhook",
      status:
        normalized.status === "verified" || input.apply?.signedProbeVerified
          ? "completed"
          : normalized.status === "verify_failed"
            ? "failed"
            : "active",
      message: getOrchestrationStatusMessage({
        ...normalized,
        phase:
          normalized.phase === "retry_wait" || normalized.phase === "verifying"
            ? normalized.phase
            : "verifying",
      }),
    });
  }

  return steps;
}

export function buildApplyResultFromState(input: {
  vercel: VercelBridgeSelection;
  pending?: VercelBridgeRedeployVerification;
  retryApply?: VercelBridgeApplyResult;
  setupBlocked?: VercelBridgeSetupBlocked;
}): VercelBridgeApplyResult {
  const pendingRaw = input.pending ?? input.vercel.redeployVerification;
  const pending = pendingRaw
    ? normalizeRedeployVerification({
        pending: pendingRaw,
        signedProbe: input.vercel.signedProbe,
      })
    : undefined;
  const retryApply = input.retryApply;
  const productionRedeployTriggered = Boolean(pending);
  const productionRedeployStatus = pending
    ? mapRedeployStatusToProductionStatus(pending.status)
    : "not_triggered";

  const setupBlocked =
    input.setupBlocked ??
    (pending?.blockedMessage
      ? {
          message: pending.blockedMessage,
          nextSteps: pending.blockedNextSteps ?? [],
        }
      : undefined);

  const signedProbeInitialResult = input.vercel.signedProbe;
  const signedProbeRetryResult = retryApply?.signedProbe;
  const signedProbeVerified =
    retryApply?.signedProbeVerified ?? input.vercel.signedProbeVerified ?? false;

  const orchestrationPhase: VercelBridgeOrchestrationPhase | undefined =
    pending?.phase;
  const orchestrationStatusMessage = pending
    ? getOrchestrationStatusMessage(pending)
    : undefined;

  return {
    actionId: pending?.actionId ?? "vercel-bridge-apply",
    status: "applied",
    projectId: input.vercel.projectId,
    projectName: input.vercel.projectName,
    writtenEnvKeys: input.pending?.writtenEnvKeys ?? [],
    skippedEnvKeys: input.pending?.skippedEnvKeys ?? [],
    linearWebhookSetup: retryApply?.linearWebhookSetup ?? {
      mode: "automated",
      manualSteps: [],
    },
    signedProbeVerified,
    signedProbeReason:
      retryApply?.signedProbeReason ?? signedProbeInitialResult?.reason,
    signedProbe: signedProbeRetryResult ?? signedProbeInitialResult,
    deploymentRedeployRequired: input.vercel.deploymentRedeployRequired ?? false,
    verificationRetry: retryApply?.verificationRetry,
    verified: retryApply?.verified ?? signedProbeVerified,
    fingerprint: pending?.fingerprint ?? input.vercel.appliedFingerprint ?? "",
    permission: retryApply?.permission ?? SETUP_PERMISSIONS.remoteSecretWrite,
    envVarsWritten: true,
    signedProbeInitialResult,
    signedProbeRetryResult,
    productionRedeployTriggered,
    productionRedeployStatus,
    setupBlocked,
    setupPending: pending ? isOrchestrationActive(pending) : false,
    pollActionId: pending?.actionId,
    orchestrationSteps: buildOrchestrationSteps({ pending, apply: retryApply }),
    orchestrationPhase,
    orchestrationStatusMessage,
    verificationAttemptCount: pending?.verificationAttemptCount,
    maxVerificationAttempts: pending?.maxVerificationAttempts,
  };
}

async function claimVerifyAttempt(input: {
  cwd?: string;
  pending: VercelBridgeRedeployVerification;
}): Promise<VercelBridgeRedeployVerification | null> {
  return withControlPlaneStateLock(input.cwd, async () => {
    const state = await readControlPlaneSetupState(input.cwd);
    const currentRaw = state?.vercel?.redeployVerification;
    if (!currentRaw || currentRaw.actionId !== input.pending.actionId) {
      return null;
    }

    const current = normalizeRedeployVerification({
      pending: currentRaw,
      signedProbe: state?.vercel?.signedProbe,
    });

    if (!isVerificationAttemptDue(current)) {
      return null;
    }

    const attemptNumber = (current.verificationAttemptCount ?? 0) + 1;
    const claim = buildVerificationClaim(attemptNumber);
    const nextPending: VercelBridgeRedeployVerification = {
      ...current,
      status: "ready",
      phase: "verifying",
      verificationClaim: claim,
      verifyAttempted: true,
      updatedAt: new Date().toISOString(),
    };

    logVercelBridgeEvent({
      phase: "verify_claim",
      actionId: current.actionId,
      pollStatus: "ready",
      verifyAttempted: true,
      verifyOnly: true,
      verificationAttemptCount: attemptNumber,
      maxVerificationAttempts:
        current.maxVerificationAttempts ?? DEFAULT_MAX_VERIFICATION_ATTEMPTS,
      verificationClaimId: claim?.claimId,
      projectId: current.projectId,
      fingerprint: current.fingerprint,
      candidateSecretSource: current.candidateSecretSource,
    });

    await updateControlPlaneSetupState(
      {
        vercel: {
          redeployVerification: nextPending,
        },
      },
      input.cwd,
    );

    return nextPending;
  });
}

async function finalizePendingState(input: {
  cwd?: string;
  pending: VercelBridgeRedeployVerification;
  status: VercelBridgeRedeployVerificationStatus;
  phase?: VercelBridgeOrchestrationPhase;
  message?: string;
  setupBlocked?: VercelBridgeSetupBlocked;
  clearPending?: boolean;
  vercelPatch?: Partial<VercelBridgeSelection>;
  verificationAttemptCount?: number;
  nextVerificationAttemptAt?: string;
  lastVerificationFailureReason?: string;
  lastVerificationFailureClass?: "retryable" | "terminal";
  signedProbe?: VercelSignedProbeEvidence;
}): Promise<void> {
  await withControlPlaneStateLock(input.cwd, async () => {
    const state = await readControlPlaneSetupState(input.cwd);
    if (!state?.vercel) {
      return;
    }

    const completedAt = new Date().toISOString();
    const nextPending: VercelBridgeRedeployVerification = {
      ...input.pending,
      status: input.status,
      phase: input.phase ?? input.pending.phase,
      updatedAt: completedAt,
      completedAt: input.clearPending ? completedAt : input.pending.completedAt ?? completedAt,
      message: input.message ?? input.pending.message,
      blockedMessage: input.setupBlocked?.message,
      blockedNextSteps: input.setupBlocked?.nextSteps,
      verificationAttemptCount:
        input.verificationAttemptCount ?? input.pending.verificationAttemptCount,
      verificationClaim: undefined,
      nextVerificationAttemptAt: input.nextVerificationAttemptAt,
      lastVerificationAttemptAt: completedAt,
      lastVerificationFailureReason: input.lastVerificationFailureReason,
      lastVerificationFailureClass: input.lastVerificationFailureClass,
    };

    await updateControlPlaneSetupState(
      {
        vercel: {
          ...input.vercelPatch,
          redeployVerification: input.clearPending ? undefined : nextPending,
        },
      },
      input.cwd,
    );
  });
}

async function persistDeployProgress(input: {
  cwd?: string;
  vercel: VercelBridgeSelection;
  pending: VercelBridgeRedeployVerification;
  status: VercelBridgeRedeployVerificationStatus;
  message?: string;
}): Promise<VercelBridgeRedeployVerification> {
  return withControlPlaneStateLock(input.cwd, async () => {
    const state = await readControlPlaneSetupState(input.cwd);
    const current = state?.vercel?.redeployVerification;
    if (!current || current.actionId !== input.pending.actionId) {
      return input.pending;
    }

    const nextPending: VercelBridgeRedeployVerification = {
      ...current,
      status: input.status,
      phase: mapPendingPhaseForDeployStatus(input.status),
      updatedAt: new Date().toISOString(),
      message: input.message ?? current.message,
    };

    await updateControlPlaneSetupState(
      {
        vercel: {
          redeployVerification: nextPending,
        },
      },
      input.cwd,
    );

    return nextPending;
  });
}

async function handleVerificationFailure(input: {
  cwd?: string;
  claimed: VercelBridgeRedeployVerification;
  retryResult: VercelBridgeApplyResult;
  vercelPatch: Partial<VercelBridgeSelection>;
}): Promise<VercelBridgeApplyResult> {
  const probe = input.retryResult.signedProbe;
  const failureClass = classifySignedProbeFailure(probe);
  const attemptNumber =
    input.claimed.verificationClaim?.attemptNumber ??
    (input.claimed.verificationAttemptCount ?? 0) + 1;
  const maxAttempts =
    input.claimed.maxVerificationAttempts ?? DEFAULT_MAX_VERIFICATION_ATTEMPTS;
  const exhausted = attemptNumber >= maxAttempts;
  const retryable = failureClass === "retryable" && !exhausted;

  if (retryable) {
    logVercelBridgeEvent({
      phase: "verify_retry",
      actionId: input.claimed.actionId,
      pollStatus: "ready",
      verifyAttempted: true,
      verifyOnly: true,
      verificationAttemptCount: attemptNumber,
      maxVerificationAttempts: maxAttempts,
      verificationFailureClass: failureClass,
      signedProbeResult: probe?.result,
      signedProbeReason: input.retryResult.signedProbeReason,
      signedProbeStatusCode: probe?.statusCode,
      fingerprint: input.claimed.fingerprint,
    });

    await finalizePendingState({
      cwd: input.cwd,
      pending: input.claimed,
      status: "ready",
      phase: "retry_wait",
      message: getOrchestrationStatusMessage({
        ...input.claimed,
        phase: "retry_wait",
        verificationAttemptCount: attemptNumber,
      }),
      verificationAttemptCount: attemptNumber,
      nextVerificationAttemptAt: new Date(
        Date.now() + VERIFICATION_POLL_INTERVAL_MS,
      ).toISOString(),
      lastVerificationFailureReason: input.retryResult.signedProbeReason,
      lastVerificationFailureClass: failureClass,
      vercelPatch: input.vercelPatch,
    });

    const latest = await readControlPlaneSetupState(input.cwd);
    return buildApplyResultFromState({
      vercel: latest!.vercel!,
      pending: latest!.vercel!.redeployVerification,
      retryApply: { ...input.retryResult, verificationRetry: true },
    });
  }

  const setupBlocked = buildSetupBlockedForPostRedeployVerificationFailure({
    retryReason: input.retryResult.signedProbeReason,
    exhausted,
  });

  logVercelBridgeEvent({
    phase: "blocked",
    actionId: input.claimed.actionId,
    pollStatus: "verify_failed",
    verificationAttemptCount: attemptNumber,
    maxVerificationAttempts: maxAttempts,
    verificationFailureClass: failureClass,
    signedProbeResult: probe?.result,
    signedProbeReason: input.retryResult.signedProbeReason,
    signedProbeStatusCode: probe?.statusCode,
    setupBlockedMessage: setupBlocked.message,
    setupBlockedNextSteps: setupBlocked.nextSteps,
    fingerprint: input.claimed.fingerprint,
  });

  await finalizePendingState({
    cwd: input.cwd,
    pending: input.claimed,
    status: "verify_failed",
    phase: "terminal",
    message: setupBlocked.message,
    setupBlocked,
    verificationAttemptCount: attemptNumber,
    lastVerificationFailureReason: input.retryResult.signedProbeReason,
    lastVerificationFailureClass: failureClass,
    vercelPatch: input.vercelPatch,
  });

  const latest = await readControlPlaneSetupState(input.cwd);
  return buildApplyResultFromState({
    vercel: latest!.vercel!,
    pending: latest!.vercel!.redeployVerification,
    retryApply: { ...input.retryResult, verificationRetry: true },
    setupBlocked,
  });
}

export async function pollVercelBridgeRedeployVerification(input: {
  actionId?: string;
  cwd?: string;
}): Promise<VercelBridgeApplyResult> {
  const state = await readControlPlaneSetupState(input.cwd);
  const vercel = state?.vercel;
  const pendingRaw = vercel?.redeployVerification;

  if (!vercel || !pendingRaw) {
    throw new Error("No pending Vercel redeploy verification is in progress.");
  }

  const pending = normalizeRedeployVerification({
    pending: pendingRaw,
    signedProbe: vercel.signedProbe,
  });

  if (input.actionId && pending.actionId !== input.actionId) {
    throw new Error("Pending Vercel redeploy verification action was not found.");
  }

  if (isTerminalRedeployVerificationStatus(pending.status)) {
    logVercelBridgeEvent({
      phase: "poll",
      actionId: pending.actionId,
      pollStatus: pending.status,
      orchestrationPhase: pending.phase,
      verificationAttemptCount: pending.verificationAttemptCount,
      maxVerificationAttempts: pending.maxVerificationAttempts,
      projectId: pending.projectId,
      projectName: pending.projectName,
      teamId: pending.teamId,
      fingerprint: pending.fingerprint,
      setupBlockedMessage: pending.blockedMessage,
    });
    return buildApplyResultFromState({
      vercel,
      pending,
      setupBlocked: pending.blockedMessage
        ? {
            message: pending.blockedMessage,
            nextSteps: pending.blockedNextSteps ?? [],
          }
        : undefined,
    });
  }

  if (!pending.newDeploymentId) {
    throw new Error("Pending Vercel redeploy verification is missing deployment id.");
  }

  const persistedPlan = await buildPollVerifyPlanFromPersistedState({
    cwd: input.cwd,
    state: state!,
    pending,
  });

  if (!persistedPlan.ok) {
    logVercelBridgeEvent({
      phase: "blocked",
      actionId: pending.actionId,
      pollStatus: "verify_failed",
      orchestrationPhase: "terminal",
      setupBlockedMessage: persistedPlan.setupBlocked.message,
      setupBlockedNextSteps: persistedPlan.setupBlocked.nextSteps,
      projectId: pending.projectId,
      fingerprint: pending.fingerprint,
    });
    await finalizePendingState({
      cwd: input.cwd,
      pending,
      status: "verify_failed",
      phase: "terminal",
      message: persistedPlan.setupBlocked.message,
      setupBlocked: persistedPlan.setupBlocked,
    });

    const latest = await readControlPlaneSetupState(input.cwd);
    const terminalPending = latest!.vercel!.redeployVerification!;
    return buildApplyResultFromState({
      vercel: latest!.vercel!,
      pending: terminalPending,
      setupBlocked: persistedPlan.setupBlocked,
    });
  }

  const inspectResult = await inspectProductionRedeployStatus({
    vercelToken: persistedPlan.vercelToken,
    newDeploymentId: pending.newDeploymentId,
    teamId: pending.teamId,
    sourceDeploymentId: pending.sourceDeploymentId,
    deadlineAt: pending.deadlineAt,
  });

  if (inspectResult.status === "failed" || inspectResult.status === "timeout") {
    const setupBlocked = {
      message: buildManualRedeployRecoveryMessage(
        inspectResult.status,
        inspectResult.message,
      ),
      nextSteps: [
        "Redeploy production in Vercel manually if needed.",
        "Use Apply Vercel Settings again to restart verification.",
      ],
    };

    logVercelBridgeEvent({
      phase: "blocked",
      actionId: pending.actionId,
      pollStatus: inspectResult.status,
      orchestrationPhase: "terminal",
      setupBlockedMessage: setupBlocked.message,
      setupBlockedNextSteps: setupBlocked.nextSteps,
      projectId: pending.projectId,
      fingerprint: pending.fingerprint,
    });

    await finalizePendingState({
      cwd: input.cwd,
      pending,
      status: inspectResult.status,
      phase: "terminal",
      message: inspectResult.message,
      setupBlocked,
    });

    const latest = await readControlPlaneSetupState(input.cwd);
    const terminalPending = latest!.vercel!.redeployVerification!;
    return buildApplyResultFromState({
      vercel: latest!.vercel!,
      pending: terminalPending,
      setupBlocked,
    });
  }

  if (inspectResult.status === "building" || inspectResult.status === "triggered") {
    logVercelBridgeEvent({
      phase: "poll",
      actionId: pending.actionId,
      pollStatus: inspectResult.status,
      orchestrationPhase: mapPendingPhaseForDeployStatus(inspectResult.status),
      verificationAttemptCount: pending.verificationAttemptCount,
      projectId: pending.projectId,
      fingerprint: pending.fingerprint,
    });
    const buildingPending = await persistDeployProgress({
      cwd: input.cwd,
      vercel,
      pending,
      status: inspectResult.status,
      message: inspectResult.message,
    });

    return buildApplyResultFromState({
      vercel: { ...vercel, redeployVerification: buildingPending },
      pending: buildingPending,
    });
  }

  if (inspectResult.status !== "ready") {
    return buildApplyResultFromState({ vercel, pending });
  }

  const readyPending = await persistDeployProgress({
    cwd: input.cwd,
    vercel,
    pending,
    status: "ready",
    message: inspectResult.message,
  });

  if (!isVerificationAttemptDue(readyPending)) {
    const notDueReason = getVerificationAttemptNotDueReason(readyPending);
    if (
      notDueReason === "deadline_expired" ||
      notDueReason === "budget_exhausted"
    ) {
      const setupBlocked =
        notDueReason === "budget_exhausted"
          ? buildSetupBlockedForPostRedeployVerificationFailure({ exhausted: true })
          : {
              message: buildManualRedeployRecoveryMessage("timeout"),
              nextSteps: [
                "Redeploy production in Vercel manually if needed.",
                "Use Apply Vercel Settings again to restart verification.",
              ],
            };
      const terminalStatus =
        notDueReason === "deadline_expired" ? "timeout" : "verify_failed";

      await finalizePendingState({
        cwd: input.cwd,
        pending: readyPending,
        status: terminalStatus,
        phase: "terminal",
        message: setupBlocked.message,
        setupBlocked,
      });

      const latest = await readControlPlaneSetupState(input.cwd);
      const terminalPending = latest!.vercel!.redeployVerification!;
      return buildApplyResultFromState({
        vercel: latest!.vercel!,
        pending: terminalPending,
        setupBlocked,
      });
    }

    return buildApplyResultFromState({
      vercel: { ...vercel, redeployVerification: readyPending },
      pending: readyPending,
    });
  }

  const claimed = await claimVerifyAttempt({ cwd: input.cwd, pending: readyPending });
  if (!claimed) {
    const latest = await readControlPlaneSetupState(input.cwd);
    return buildApplyResultFromState({
      vercel: latest!.vercel!,
      pending: latest!.vercel!.redeployVerification,
    });
  }

  logVercelBridgeEvent({
    phase: "verify_retry",
    actionId: claimed.actionId,
    pollStatus: "ready",
    verifyAttempted: true,
    verifyOnly: true,
    verificationAttemptCount: claimed.verificationClaim?.attemptNumber,
    maxVerificationAttempts:
      claimed.maxVerificationAttempts ?? DEFAULT_MAX_VERIFICATION_ATTEMPTS,
    verificationClaimId: claimed.verificationClaim?.claimId,
    projectId: claimed.projectId,
    fingerprint: claimed.fingerprint,
    candidateSecretSource: claimed.candidateSecretSource,
  });

  const retryResult = await applyVercelBridgeSetup({
    plan: persistedPlan.plan,
    confirmed: true,
    fingerprint: persistedPlan.applyFingerprint,
    verifyOnly: true,
    cwd: input.cwd,
  });

  const latestAfterApply = await readControlPlaneSetupState(input.cwd);
  const vercelPatch = {
    productionUrl: latestAfterApply?.vercel?.productionUrl,
    webhookUrl: latestAfterApply?.vercel?.webhookUrl,
    signedProbe: retryResult.signedProbe,
  };

  if (retryResult.signedProbeVerified && retryResult.verified) {
    logVercelBridgeEvent({
      phase: "signed_probe",
      actionId: claimed.actionId,
      pollStatus: "verified",
      orchestrationPhase: "verified",
      verificationAttemptCount: claimed.verificationClaim?.attemptNumber,
      signedProbeResult: retryResult.signedProbe?.result,
      signedProbeReason: retryResult.signedProbeReason,
      signedProbeStatusCode: retryResult.signedProbe?.statusCode,
      fingerprint: claimed.fingerprint,
    });
    await finalizePendingState({
      cwd: input.cwd,
      pending: claimed,
      status: "verified",
      phase: "verified",
      message: "Signed webhook verification passed after production redeploy.",
      clearPending: true,
      verificationAttemptCount: claimed.verificationClaim?.attemptNumber,
      vercelPatch: {
        ...vercelPatch,
        signedProbeVerified: true,
        deploymentRedeployRequired: false,
      },
    });

    const latest = await readControlPlaneSetupState(input.cwd);
    return buildApplyResultFromState({
      vercel: latest!.vercel!,
      pending: {
        ...claimed,
        status: "verified",
        phase: "verified",
        completedAt: new Date().toISOString(),
      },
      retryApply: retryResult,
    });
  }

  return handleVerificationFailure({
    cwd: input.cwd,
    claimed,
    retryResult,
    vercelPatch: {
      ...vercelPatch,
      signedProbeVerified: false,
      deploymentRedeployRequired: true,
    },
  });
}
