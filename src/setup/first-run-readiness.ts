import type { SetupGuiViewModel } from "./gui-view-model.js";
import type { RemoteSetupSummary } from "./remote-setup-summary.js";
import {
  evaluateHarnessSecretPresence,
  HARNESS_ACTIONS_SECRET_NAMES,
  type HarnessActionsSecretName,
  type RemoteHarnessSecretApplyResult,
} from "./remote-actions.js";
import type { StaleSmokeDiagnostics } from "./stale-smoke-repo.js";
import {
  remoteSetupBlockedByStaleSmoke,
  shouldSuppressRemoteDownstreamStatus,
} from "./stale-smoke-repo.js";
import {
  collectConnectServicesBlockers,
  collectLinearWorkspaceBlockers,
  collectVercelBridgeBlockers,
  computeCloudSecretsConfigStateFingerprint,
  isCloudSecretsStaleFromControlPlane,
} from "./control-plane-readiness.js";
import type { ControlPlaneReadinessContext } from "./control-plane-types.js";
import type { HarnessRepoProvisioningSummary } from "./harness-repo-provisioning.js";

export type FirstRunStepId =
  | "connect-services"
  | "linear-workspace"
  | "vercel-bridge"
  | "local-setup"
  | "local-readiness"
  | "cloud-secrets"
  | "target-workflow"
  | "ready-for-first-run";

export type FirstRunStepStatus =
  | "not_started"
  | "in_progress"
  | "blocked"
  | "ready"
  | "complete";

export interface ReadinessBlocker {
  id: string;
  stepId: FirstRunStepId;
  message: string;
  action: string;
  priority: number;
  blocking: boolean;
  tone?: "setup_needed" | "error";
}

export interface ReadinessAction {
  id: string;
  label: string;
  stepId: FirstRunStepId;
}

export interface FirstRunStep {
  id: FirstRunStepId;
  label: string;
  status: FirstRunStepStatus;
  summary: string;
  blockers: ReadinessBlocker[];
  warnings: ReadinessBlocker[];
  primaryAction?: ReadinessAction;
  inspectable: boolean;
  actionable: boolean;
}

export interface FirstRunReadinessUiState {
  localPreviewStale?: boolean;
  /** True after the operator opened the optional cloud-secrets preview disclosure. */
  cloudSecretsPreviewOpened?: boolean;
  remoteSecretPreviewStale?: boolean;
  linearPreviewStale?: boolean;
  vercelPreviewStale?: boolean;
  /** Set when the operator finishes reviewing local readiness and continues. */
  localReadinessReviewed?: boolean;
  /** Set when the operator finishes cloud secrets setup and continues. */
  cloudSecretsReviewed?: boolean;
  /** Verified automatic cloud-secrets apply evidence for blocker resolution. */
  cloudSecretsApplyEvidence?: CloudSecretsApplyEvidence;
}

export interface CloudSecretsApplyEvidence {
  path: "automatic";
  applyFingerprint: string;
  configStateFingerprint: string;
  harnessConfigJsonB64Written: boolean;
  harnessDispatchRepo?: string;
  harnessDispatchRepoResolved?: boolean;
  harnessDispatchRepoSource?: string;
  harnessRepoAccess?: RemoteSetupSummary["harnessRepoAccess"];
  postApplyVerificationReady?: boolean;
  secretPresence?: {
    allPresent: boolean;
    missing: string[];
    unknown: string[];
  };
}

export type Step6AutomaticApplyOutcomeKind =
  | "idle"
  | "success"
  | "stale-after-apply"
  | "apply-failed"
  | "verification-inconclusive"
  | "success-blocked";

export interface Step6AutomaticApplyOutcome {
  kind: Step6AutomaticApplyOutcomeKind;
  message?: string;
  primaryBlocker?: ReadinessBlocker;
  canContinue?: boolean;
  showRetry?: boolean;
  showRefresh?: boolean;
}

export interface PrimarySetupTask {
  id: string;
  stepId: FirstRunStepId;
  title: string;
  problem: string;
  whyItMatters: string;
  neededFromYou: string;
  primaryCtaLabel: string;
  secondaryCtaLabel: string;
  tone?: "setup_needed" | "error";
}

export interface FirstRunReadiness {
  steps: FirstRunStep[];
  currentStepId: FirstRunStepId;
  highestPriorityBlocker?: ReadinessBlocker;
  nextRecommendedAction?: ReadinessAction;
  primaryTask?: PrimarySetupTask;
  staleSmokeDiagnostics: StaleSmokeDiagnostics;
  remoteSetupBlockedByUpstream: boolean;
  readyForFirstRun: boolean;
  localReadinessBlockersCleared: boolean;
  localReadinessReviewed: boolean;
  localReadinessComplete: boolean;
  cloudSecretsBlockersCleared: boolean;
  cloudSecretsReviewed: boolean;
  nonBlockingWarnings: ReadinessBlocker[];
  prohibitedActionsNote: string;
}

const STEP_ORDER: FirstRunStepId[] = [
  "connect-services",
  "linear-workspace",
  "vercel-bridge",
  "local-setup",
  "local-readiness",
  "cloud-secrets",
  "target-workflow",
  "ready-for-first-run",
];

const STEP_LABELS: Record<FirstRunStepId, string> = {
  "connect-services": "Connect services",
  "linear-workspace": "Set up Linear workspace",
  "vercel-bridge": "Set up Vercel webhook bridge",
  "local-setup": "Choose target repo(s)",
  "local-readiness": "Check local readiness",
  "cloud-secrets": "Connect cloud secrets",
  "target-workflow": "Install target repo workflow",
  "ready-for-first-run": "Ready for first run",
};

const PROHIBITED_ACTIONS_NOTE =
  "M6 confirms setup readiness only. It does not trigger harness phases, Linear automation, cloud workflow dispatch, implementation branches, or issue-work PRs. A later milestone may add a safe first-issue dry run.";

function localFileExists(
  summary: SetupGuiViewModel,
  label: string,
): boolean {
  return summary.localFiles.find((file) => file.label === label)?.exists ?? false;
}

const SETUP_NEEDED_BLOCKER_IDS = new Set([
  "missing-env-local",
  "missing-config-local",
  "missing-harness-config-path",
  "missing-linear-key",
  "missing-cursor-key",
  "missing-github-token",
  "missing-vercel-token",
  "config-unresolved",
  "linear-workspace-not-applied",
  "vercel-bridge-not-applied",
]);

function pushBlocker(
  blockers: ReadinessBlocker[],
  blocker: Omit<ReadinessBlocker, "blocking" | "tone"> & {
    blocking?: boolean;
    tone?: "setup_needed" | "error";
  },
): void {
  blockers.push({
    blocking: true,
    tone: blocker.tone ?? (SETUP_NEEDED_BLOCKER_IDS.has(blocker.id)
      ? "setup_needed"
      : "error"),
    ...blocker,
  });
}

function pushWarning(
  warnings: ReadinessBlocker[],
  blocker: Omit<ReadinessBlocker, "blocking">,
): void {
  warnings.push({ ...blocker, blocking: false });
}

export function collectLocalSetupBlockers(
  summary: SetupGuiViewModel,
  uiState?: FirstRunReadinessUiState,
  staleSmokeDiagnostics?: StaleSmokeDiagnostics,
): ReadinessBlocker[] {
  const blockers: ReadinessBlocker[] = [];

  if (!localFileExists(summary, ".env.local")) {
    pushBlocker(blockers, {
      id: "missing-env-local",
      stepId: "local-setup",
      message: "Setup needed: create .env.local on this machine.",
      action: "Add your target repo in Step 4, then preview setup files.",
      priority: 100,
    });
  }

  if (!localFileExists(summary, ".harness/config.local.json")) {
    pushBlocker(blockers, {
      id: "missing-config-local",
      stepId: "local-setup",
      message: "Setup needed: create .harness/config.local.json.",
      action: "Choose your target repo in Step 4, then preview setup files.",
      priority: 101,
    });
  }

  if (!summary.envKeyPresence.HARNESS_CONFIG_PATH) {
    pushBlocker(blockers, {
      id: "missing-harness-config-path",
      stepId: "local-setup",
      message: "Setup needed: HARNESS_CONFIG_PATH is not configured yet.",
      action:
        "This is set automatically when you create local setup files.",
      priority: 102,
    });
  }

  if (!summary.overview.configResolved && !summary.configSource.parseError) {
    pushBlocker(blockers, {
      id: "config-unresolved",
      stepId: "local-setup",
      message: "Setup needed: harness config is not configured locally yet.",
      action: "Complete Step 4 to create local setup files.",
      priority: 106,
    });
  }

  if (uiState?.localPreviewStale) {
    pushBlocker(blockers, {
      id: "local-preview-stale",
      stepId: "local-setup",
      message: "Blocked: Local preview is out of date.",
      action:
        "Next: Regenerate preview after your latest edits, then confirm and apply.",
      priority: 107,
    });
  }

  if (staleSmokeDiagnostics?.hasStaleConfig) {
    if (staleSmokeDiagnostics.staleHarnessDispatchRepo) {
      pushBlocker(blockers, {
        id: "stale-smoke-dispatch-repo",
        stepId: "local-setup",
        message:
          "Blocked: Your setup points at an old disposable smoke-test harness repo.",
        action:
          "Next: Reset GITHUB_DISPATCH_REPOSITORY to your current harness repo, preview local setup, then apply.",
        priority: 108,
      });
    }

    if (staleSmokeDiagnostics.staleTargetRepos.length > 0) {
      pushBlocker(blockers, {
        id: "stale-smoke-target-repo",
        stepId: "local-setup",
        message:
          "Blocked: Target repo config still points at an old disposable smoke-test repo.",
        action:
          "Next: Enter your intended target repo in Local setup, preview local setup, then apply.",
        priority: 109,
      });
    }
  }

  return blockers.sort((left, right) => left.priority - right.priority);
}

export function collectLocalReadinessBlockers(
  summary: SetupGuiViewModel,
): { blockers: ReadinessBlocker[]; warnings: ReadinessBlocker[] } {
  const blockers: ReadinessBlocker[] = [];
  const warnings: ReadinessBlocker[] = [];

  if (summary.configSource.parseError) {
    pushBlocker(blockers, {
      id: "config-parse-error",
      stepId: "local-readiness",
      message: "Blocked: Harness config does not parse.",
      action:
        "Next: Fix .harness/config.local.json validation errors in Local setup.",
      priority: 200,
    });
  }

  if (summary.configSummary && !summary.configSummary.closureValid) {
    pushBlocker(blockers, {
      id: "allowed-target-repos-closure",
      stepId: "local-readiness",
      message:
        "Blocked: allowedTargetRepos does not cover every configured target repo.",
      action:
        "Next: Update target repo config so allowedTargetRepos includes each mapping.",
      priority: 201,
    });
  }

  return {
    blockers: blockers.sort((left, right) => left.priority - right.priority),
    warnings: warnings.sort((left, right) => left.priority - right.priority),
  };
}

function missingHarnessSecrets(
  remoteSummary: RemoteSetupSummary,
): HarnessActionsSecretName[] {
  const statusByName = new Map(
    remoteSummary.harnessSecretStatuses.map((entry) => [entry.name, entry.status]),
  );

  return HARNESS_ACTIONS_SECRET_NAMES.filter(
    (name) => statusByName.get(name) === "missing",
  );
}

export function collectCloudSecretsBlockers(
  _summary: SetupGuiViewModel,
  remoteSummary: RemoteSetupSummary,
  uiState?: FirstRunReadinessUiState,
  staleSmokeDiagnostics?: StaleSmokeDiagnostics,
  controlPlaneContext?: ControlPlaneReadinessContext,
): { blockers: ReadinessBlocker[]; warnings: ReadinessBlocker[] } {
  const blockers: ReadinessBlocker[] = [];
  const warnings: ReadinessBlocker[] = [];
  const suppressDownstream = staleSmokeDiagnostics
    ? shouldSuppressRemoteDownstreamStatus(
        staleSmokeDiagnostics,
        remoteSummary.harnessRepoAccess,
      )
    : false;

  if (suppressDownstream) {
    return { blockers, warnings };
  }

  if (!remoteSummary.githubTokenConfigured) {
    pushBlocker(blockers, {
      id: "missing-github-token-remote",
      stepId: "cloud-secrets",
      message: "Blocked: GITHUB_TOKEN is required for cloud secrets setup.",
      action:
        "Next: Add GITHUB_TOKEN in local setup, then return to Connect cloud secrets.",
      priority: 300,
    });
  }

  if (!remoteSummary.harnessDispatchRepoResolved) {
    pushBlocker(blockers, {
      id: "harness-dispatch-repo-unresolved",
      stepId: "cloud-secrets",
      message: "Blocked: Harness dispatch repo could not be resolved.",
      action:
        "Next: Return to Step 4, enter your harness repo, and use Verify and use harness repo.",
      priority: 301,
    });
  }

  if (remoteSummary.harnessRepoAccess === "denied") {
    pushBlocker(blockers, {
      id: "harness-repo-access-denied",
      stepId: "cloud-secrets",
      message: `Blocked: I tried to check ${remoteSummary.harnessDispatchRepo} and GitHub denied access.`,
      action:
        "Next: Return to Step 4 to correct the harness repo, or update GITHUB_TOKEN permissions in Step 1 and verify again.",
      priority: 302,
    });
  } else if (
    remoteSummary.harnessRepoAccess === "unknown" &&
    remoteSummary.harnessDispatchRepoResolved
  ) {
    pushBlocker(blockers, {
      id: "harness-repo-access-unknown",
      stepId: "cloud-secrets",
      message: "Blocked: Harness repo access could not be verified yet.",
      action:
        "Next: Return to Step 4 and use Verify and use harness repo, or refresh after saving GITHUB_TOKEN in Step 1.",
      priority: 303,
    });
  }

  for (const secretName of missingHarnessSecrets(remoteSummary)) {
    pushBlocker(blockers, {
      id: `missing-harness-secret-${secretName}`,
      stepId: "cloud-secrets",
      message: `Blocked: Required cloud secret ${secretName} is missing.`,
      action:
        "Next: Review generated secrets, confirm, then create or update encrypted GitHub Actions secrets.",
      priority: 303,
    });
  }

  for (const secret of remoteSummary.harnessSecretStatuses) {
    if (secret.status === "unknown" && remoteSummary.githubTokenConfigured) {
      pushWarning(warnings, {
        id: `harness-secret-unknown-${secret.name}`,
        stepId: "cloud-secrets",
        message: `Cloud secret ${secret.name} status is unknown.`,
        action: "Refresh cloud secrets setup to re-check secret presence.",
        priority: 591,
      });
    }
  }

  if (uiState?.remoteSecretPreviewStale && uiState.cloudSecretsPreviewOpened) {
    pushBlocker(blockers, {
      id: "remote-secret-preview-stale",
      stepId: "cloud-secrets",
      message: "Blocked: Cloud secrets preview is out of date.",
      action:
        "Next: Regenerate the secrets preview, then confirm and create or update secrets.",
      priority: 307,
    });
  }

  if (
    controlPlaneContext &&
    isCloudSecretsStaleFromControlPlane(controlPlaneContext)
  ) {
    pushBlocker(blockers, {
      id: "cloud-secrets-stale-linear-config",
      stepId: "cloud-secrets",
      message:
        "Blocked: HARNESS_CONFIG_JSON_B64 is stale after Linear workspace changes.",
      action:
        "Next: Regenerate cloud secrets preview after updating local config, then apply.",
      priority: 308,
      tone: "error",
    });
  }

  return {
    blockers: blockers.sort((left, right) => left.priority - right.priority),
    warnings: warnings.sort((left, right) => left.priority - right.priority),
  };
}

export function step6PostApplyVerificationReady(
  summary: RemoteSetupSummary,
): boolean {
  const presence = evaluateHarnessSecretPresence(summary.harnessSecretStatuses);
  return (
    summary.harnessDispatchRepoResolved &&
    summary.harnessRepoAccess !== "denied" &&
    presence.allPresent
  );
}

export function harnessConfigJsonB64WasWritten(
  applyResult?: RemoteHarnessSecretApplyResult,
): boolean {
  if (!applyResult) {
    return false;
  }
  return applyResult.writtenSecrets.some(
    (entry) =>
      entry.name === "HARNESS_CONFIG_JSON_B64" &&
      (entry.status === "created" || entry.status === "updated"),
  );
}

export function buildCloudSecretsApplyEvidence(input: {
  applyResult: RemoteHarnessSecretApplyResult;
  setupSummary: SetupGuiViewModel;
  controlPlaneContext?: ControlPlaneReadinessContext;
  remoteSummary?: RemoteSetupSummary;
}): CloudSecretsApplyEvidence {
  return buildAuthoritativeCloudSecretsApplyEvidence({
    applyResult: input.applyResult,
    setupSummary: input.setupSummary,
    controlPlaneContext: input.controlPlaneContext,
    remoteSummary: input.remoteSummary,
  });
}

export function buildAuthoritativeCloudSecretsApplyEvidence(input: {
  applyResult: RemoteHarnessSecretApplyResult;
  setupSummary: SetupGuiViewModel;
  controlPlaneContext?: ControlPlaneReadinessContext;
  remoteSummary?: RemoteSetupSummary;
}): CloudSecretsApplyEvidence {
  const remoteSummary = input.remoteSummary;
  const secretPresence = remoteSummary
    ? evaluateHarnessSecretPresence(remoteSummary.harnessSecretStatuses)
    : undefined;

  return {
    path: "automatic",
    applyFingerprint: input.applyResult.fingerprint,
    configStateFingerprint: computeCloudSecretsConfigStateFingerprint({
      setupSummary: input.setupSummary,
      controlPlaneContext: input.controlPlaneContext,
    }),
    harnessConfigJsonB64Written: harnessConfigJsonB64WasWritten(
      input.applyResult,
    ),
    harnessDispatchRepo:
      remoteSummary?.harnessDispatchRepo ?? input.applyResult.harnessDispatchRepo,
    harnessDispatchRepoResolved: remoteSummary?.harnessDispatchRepoResolved,
    harnessDispatchRepoSource: remoteSummary?.harnessDispatchRepoSource,
    harnessRepoAccess: remoteSummary?.harnessRepoAccess,
    postApplyVerificationReady: remoteSummary
      ? step6PostApplyVerificationReady(remoteSummary)
      : undefined,
    secretPresence: secretPresence
      ? {
          allPresent: secretPresence.allPresent,
          missing: secretPresence.missing,
          unknown: secretPresence.unknown,
        }
      : undefined,
  };
}

export function shouldInvalidateCloudSecretsApplyEvidence(input: {
  evidence?: CloudSecretsApplyEvidence;
  currentConfigStateFingerprint: string;
  harnessDispatchRepo?: string;
}): boolean {
  if (!input.evidence) {
    return false;
  }
  if (
    input.evidence.harnessDispatchRepo &&
    input.harnessDispatchRepo &&
    input.evidence.harnessDispatchRepo !== input.harnessDispatchRepo
  ) {
    return true;
  }
  return (
    input.evidence.configStateFingerprint !== input.currentConfigStateFingerprint
  );
}

export function isCloudSecretsApplyEvidenceCurrent(input: {
  evidence?: CloudSecretsApplyEvidence;
  currentConfigStateFingerprint: string;
  harnessDispatchRepo?: string;
}): boolean {
  if (!input.evidence) {
    return false;
  }
  if (shouldInvalidateCloudSecretsApplyEvidence(input)) {
    return false;
  }
  return isCloudSecretsStaleLinearConfigResolved({
    evidence: input.evidence,
    currentConfigStateFingerprint: input.currentConfigStateFingerprint,
  });
}

export function deriveStep6AutomaticApplyOutcome(input: {
  setupType: "automatic" | "manual" | null;
  loading: string | null;
  applyError: string | null;
  applyResult: RemoteHarnessSecretApplyResult | null;
  verifiedAutomaticSuccess: boolean;
  cloudSecretsApplyEvidence?: CloudSecretsApplyEvidence;
  eligibility: Step6ContinueEligibility;
  currentConfigStateFingerprint: string;
  harnessDispatchRepo?: string;
}): Step6AutomaticApplyOutcome {
  if (input.setupType !== "automatic") {
    return { kind: "idle" };
  }

  if (input.loading === "apply") {
    return { kind: "idle" };
  }

  if (input.applyError) {
    return {
      kind: "apply-failed",
      message: input.applyError,
      showRetry: true,
    };
  }

  const evidenceCurrent = isCloudSecretsApplyEvidenceCurrent({
    evidence: input.cloudSecretsApplyEvidence,
    currentConfigStateFingerprint: input.currentConfigStateFingerprint,
    harnessDispatchRepo: input.harnessDispatchRepo,
  });

  const hasAutomaticProof =
    input.verifiedAutomaticSuccess ||
    (Boolean(input.applyResult) && evidenceCurrent);

  if (!hasAutomaticProof) {
    return { kind: "idle" };
  }

  if (
    input.cloudSecretsApplyEvidence &&
    shouldInvalidateCloudSecretsApplyEvidence({
      evidence: input.cloudSecretsApplyEvidence,
      currentConfigStateFingerprint: input.currentConfigStateFingerprint,
      harnessDispatchRepo: input.harnessDispatchRepo,
    })
  ) {
    return {
      kind: "stale-after-apply",
      message:
        "Local or control-plane config changed after the last automatic secret write. Preview and apply again to refresh HARNESS_CONFIG_JSON_B64.",
      showRetry: true,
      primaryBlocker: input.eligibility.blockers.find(
        (blocker) => blocker.id === "cloud-secrets-stale-linear-config",
      ),
    };
  }

  if (!input.eligibility.postApplyVerificationReady) {
    return {
      kind: "verification-inconclusive",
      message:
        "Write request completed, but remote secret verification is not ready yet. Refresh or retry.",
      showRefresh: true,
      showRetry: true,
    };
  }

  if (input.eligibility.canContinue) {
    return {
      kind: "success",
      message:
        "Encrypted GitHub Actions secrets were created or updated successfully.",
      canContinue: true,
    };
  }

  return {
    kind: "success-blocked",
    message:
      "Automatic secret write succeeded, but Step 6 is not ready to continue yet.",
    primaryBlocker: input.eligibility.blockers[0],
    showRefresh: true,
    showRetry: true,
  };
}

export function assertStep6AutomaticApplyOutcomeInvariant(input: {
  outcome: Step6AutomaticApplyOutcome;
  verifiedAutomaticSuccess: boolean;
  applyResult: RemoteHarnessSecretApplyResult | null;
  loading: string | null;
  canContinue: boolean;
}): void {
  const silentDeadEnd =
    input.verifiedAutomaticSuccess &&
    Boolean(input.applyResult) &&
    input.loading !== "apply" &&
    !input.canContinue &&
    input.outcome.kind !== "stale-after-apply" &&
    input.outcome.kind !== "apply-failed" &&
    input.outcome.kind !== "verification-inconclusive" &&
    input.outcome.kind !== "success-blocked";

  if (silentDeadEnd) {
    throw new Error(
      "Step 6 automatic apply entered a silent dead-end state without explicit recovery UI.",
    );
  }
}

export function isCloudSecretsStaleLinearConfigResolved(input: {
  evidence?: CloudSecretsApplyEvidence;
  currentConfigStateFingerprint: string;
}): boolean {
  if (!input.evidence) return false;
  if (input.evidence.path !== "automatic") return false;
  if (!input.evidence.harnessConfigJsonB64Written) return false;
  return input.evidence.configStateFingerprint === input.currentConfigStateFingerprint;
}

export function filterResolvedCloudSecretsBlockers(input: {
  blockers: ReadinessBlocker[];
  evidence?: CloudSecretsApplyEvidence;
  currentConfigStateFingerprint: string;
  previewStaleCleared?: boolean;
  postApplyVerificationReady?: boolean;
}): ReadinessBlocker[] {
  return input.blockers.filter((blocker) => {
    if (blocker.id === "remote-secret-preview-stale") {
      return !(input.previewStaleCleared && input.postApplyVerificationReady);
    }
    if (blocker.id === "cloud-secrets-stale-linear-config") {
      return !isCloudSecretsStaleLinearConfigResolved({
        evidence: input.evidence,
        currentConfigStateFingerprint: input.currentConfigStateFingerprint,
      });
    }
    return true;
  });
}

export interface DeriveStep6ContinueEligibilityInput {
  summary: RemoteSetupSummary;
  setupSummary: SetupGuiViewModel;
  localReadinessComplete: boolean;
  uiState?: FirstRunReadinessUiState;
  staleSmokeDiagnostics: StaleSmokeDiagnostics;
  controlPlaneContext?: ControlPlaneReadinessContext;
  /** When true, remote-secret-preview-stale is treated as cleared. */
  previewStaleCleared?: boolean;
}

export interface Step6ContinueEligibility {
  canContinue: boolean;
  postApplyVerificationReady: boolean;
  blockers: ReadinessBlocker[];
}

function resolveStep6HardBlockers(
  blockers: ReadinessBlocker[],
  input: {
    postApplyVerificationReady: boolean;
    previewStaleCleared: boolean;
    evidence?: CloudSecretsApplyEvidence;
    currentConfigStateFingerprint: string;
  },
): ReadinessBlocker[] {
  return filterResolvedCloudSecretsBlockers({
    blockers,
    evidence: input.evidence,
    currentConfigStateFingerprint: input.currentConfigStateFingerprint,
    previewStaleCleared: input.previewStaleCleared,
    postApplyVerificationReady: input.postApplyVerificationReady,
  });
}

export type Step6RemoteActionRoute = "step4-harness-repo" | "connect-services";

export interface Step6RemoteActionEligibility {
  allowed: boolean;
  reason?: string;
  action?: string;
  route?: Step6RemoteActionRoute;
}

export function deriveStep6RemoteActionEligibility(
  summary: RemoteSetupSummary,
): Step6RemoteActionEligibility {
  if (!summary.githubTokenConfigured) {
    return {
      allowed: false,
      reason: "Blocked: GITHUB_TOKEN is required for cloud secrets setup.",
      action: "Add GITHUB_TOKEN in Step 1, then return to cloud secrets setup.",
      route: "connect-services",
    };
  }

  if (!summary.harnessDispatchRepoResolved) {
    return {
      allowed: false,
      reason: "Blocked: Harness dispatch repo could not be resolved.",
      action:
        "Return to Step 4, enter your harness repo, and use Verify and use harness repo.",
      route: "step4-harness-repo",
    };
  }

  if (summary.harnessRepoAccess === "denied") {
    return {
      allowed: false,
      reason: `Blocked: GitHub denied access to ${summary.harnessDispatchRepo}.`,
      action:
        "Return to Step 4 to correct the harness repo, or update GITHUB_TOKEN permissions in Step 1 and verify again.",
      route: "step4-harness-repo",
    };
  }

  if (summary.harnessRepoAccess !== "available") {
    return {
      allowed: false,
      reason: "Blocked: Harness repo access could not be verified yet.",
      action:
        "Return to Step 4 and use Verify and use harness repo, then refresh cloud secrets setup.",
      route: "step4-harness-repo",
    };
  }

  return { allowed: true };
}

export function deriveStep6ContinueEligibility(
  input: DeriveStep6ContinueEligibilityInput,
): Step6ContinueEligibility {
  const postApplyVerificationReady = step6PostApplyVerificationReady(
    input.summary,
  );
  const previewStaleCleared = input.previewStaleCleared ?? false;

  const effectiveUiState: FirstRunReadinessUiState = {
    ...input.uiState,
    remoteSecretPreviewStale: previewStaleCleared
      ? false
      : input.uiState?.remoteSecretPreviewStale,
  };

  const cloudSecrets = collectCloudSecretsBlockers(
    input.setupSummary,
    input.summary,
    effectiveUiState,
    input.staleSmokeDiagnostics,
    input.controlPlaneContext,
  );

  const remainingBlockers = resolveStep6HardBlockers(cloudSecrets.blockers, {
    postApplyVerificationReady,
    previewStaleCleared,
    evidence: input.uiState?.cloudSecretsApplyEvidence,
    currentConfigStateFingerprint: computeCloudSecretsConfigStateFingerprint({
      setupSummary: input.setupSummary,
      controlPlaneContext: input.controlPlaneContext,
    }),
  });

  const canContinue =
    postApplyVerificationReady &&
    input.localReadinessComplete &&
    remainingBlockers.length === 0;

  return {
    canContinue,
    postApplyVerificationReady,
    blockers: remainingBlockers,
  };
}

export function collectTargetWorkflowBlockers(
  summary: SetupGuiViewModel,
  remoteSummary: RemoteSetupSummary,
  staleSmokeDiagnostics?: StaleSmokeDiagnostics,
): { blockers: ReadinessBlocker[]; warnings: ReadinessBlocker[] } {
  const blockers: ReadinessBlocker[] = [];
  const warnings: ReadinessBlocker[] = [];
  const suppressDownstream = staleSmokeDiagnostics
    ? shouldSuppressRemoteDownstreamStatus(
        staleSmokeDiagnostics,
        remoteSummary.harnessRepoAccess,
      )
    : false;

  if (suppressDownstream) {
    return { blockers, warnings };
  }

  if (!remoteSummary.githubTokenConfigured) {
    pushBlocker(blockers, {
      id: "missing-github-token-remote-workflow",
      stepId: "target-workflow",
      message: "Blocked: GITHUB_TOKEN is required for workflow install.",
      action: "Next: Add GITHUB_TOKEN in local setup, then return to workflow install.",
      priority: 310,
    });
  }

  if (remoteSummary.targetRepos.length === 0 && summary.overview.configResolved) {
    pushBlocker(blockers, {
      id: "missing-target-repos",
      stepId: "target-workflow",
      message: "Blocked: No target repos are configured for workflow install.",
      action: "Next: Add at least one target repo mapping in local setup.",
      priority: 304,
    });
  }

  for (const repo of remoteSummary.targetRepos) {
    if (repo.repoAccess === "denied") {
      pushBlocker(blockers, {
        id: `target-repo-access-denied-${repo.repoConfigId}`,
        stepId: "target-workflow",
        message: `Blocked: GitHub access to ${repo.targetRepo} was denied.`,
        action:
          "Next: Grant workflow and PR permissions for this target repo, then refresh.",
        priority: 305,
      });
    }

    if (repo.workflowStatus === "missing" || repo.workflowStatus === "differs") {
      const workflowLabel =
        repo.workflowStatus === "missing" ? "missing" : "outdated";
      pushBlocker(blockers, {
        id: `target-workflow-${repo.workflowStatus}-${repo.repoConfigId}`,
        stepId: "target-workflow",
        message: `Blocked: Target workflow is ${workflowLabel} for ${repo.repoConfigId}.`,
        action:
          "Next: Preview the workflow install PR, confirm, then create or update the install PR.",
        priority: 306,
      });
    }

    if (repo.workflowStatus === "unknown" && remoteSummary.githubTokenConfigured) {
      pushWarning(warnings, {
        id: `target-workflow-unknown-${repo.repoConfigId}`,
        stepId: "target-workflow",
        message: `Target workflow status is unknown for ${repo.repoConfigId}.`,
        action: "Refresh workflow install setup to re-check workflow presence.",
        priority: 592,
      });
    }
  }

  return {
    blockers: blockers.sort((left, right) => left.priority - right.priority),
    warnings: warnings.sort((left, right) => left.priority - right.priority),
  };
}

export function collectRemoteSetupBlockers(
  summary: SetupGuiViewModel,
  remoteSummary: RemoteSetupSummary,
  uiState?: FirstRunReadinessUiState,
  staleSmokeDiagnostics?: StaleSmokeDiagnostics,
  controlPlaneContext?: ControlPlaneReadinessContext,
): { blockers: ReadinessBlocker[]; warnings: ReadinessBlocker[] } {
  const cloudSecrets = collectCloudSecretsBlockers(
    summary,
    remoteSummary,
    uiState,
    staleSmokeDiagnostics,
    controlPlaneContext,
  );
  const targetWorkflow = collectTargetWorkflowBlockers(
    summary,
    remoteSummary,
    staleSmokeDiagnostics,
  );

  return {
    blockers: [...cloudSecrets.blockers, ...targetWorkflow.blockers].sort(
      (left, right) => left.priority - right.priority,
    ),
    warnings: [...cloudSecrets.warnings, ...targetWorkflow.warnings].sort(
      (left, right) => left.priority - right.priority,
    ),
  };
}

function stepPrerequisitesMet(
  stepId: FirstRunStepId,
  connectServicesComplete: boolean,
  linearWorkspaceComplete: boolean,
  vercelBridgeComplete: boolean,
  localSetupComplete: boolean,
  localReadinessComplete: boolean,
  cloudSecretsComplete: boolean,
  targetWorkflowComplete: boolean,
): boolean {
  switch (stepId) {
    case "connect-services":
      return true;
    case "linear-workspace":
      return connectServicesComplete;
    case "vercel-bridge":
      return linearWorkspaceComplete;
    case "local-setup":
      return vercelBridgeComplete;
    case "local-readiness":
      return localSetupComplete;
    case "cloud-secrets":
      return localReadinessComplete;
    case "target-workflow":
      return cloudSecretsComplete;
    case "ready-for-first-run":
      return targetWorkflowComplete;
  }
}

function primaryActionForStep(
  stepId: FirstRunStepId,
  blockers: ReadinessBlocker[],
): ReadinessAction | undefined {
  const stepBlocker = blockers.find((blocker) => blocker.stepId === stepId);
  if (stepBlocker) {
    return {
      id: stepBlocker.id,
      label: stepBlocker.action.replace(/^Next:\s*/, ""),
      stepId,
    };
  }

  switch (stepId) {
    case "connect-services":
      return {
        id: "preview-connect-services",
        label: "Connect services",
        stepId,
      };
    case "linear-workspace":
      return {
        id: "complete-linear-workspace",
        label: "Set up Linear workspace",
        stepId,
      };
    case "vercel-bridge":
      return {
        id: "complete-vercel-bridge",
        label: "Set up Vercel webhook bridge",
        stepId,
      };
    case "local-setup":
      return {
        id: "preview-local-files",
        label: "Preview setup files",
        stepId,
      };
    case "local-readiness":
      return {
        id: "review-local-readiness",
        label: "Review local readiness checks",
        stepId,
      };
    case "cloud-secrets":
      return {
        id: "complete-cloud-secrets",
        label: "Connect cloud secrets",
        stepId,
      };
    case "target-workflow":
      return {
        id: "complete-target-workflow",
        label: "Install target repo workflow",
        stepId,
      };
    case "ready-for-first-run":
      return {
        id: "review-first-run-readiness",
        label: "Review final readiness state",
        stepId,
      };
  }
}

function blockersAreSetupNeeded(blockers: ReadinessBlocker[]): boolean {
  return (
    blockers.length > 0 &&
    blockers.every((blocker) => blocker.tone === "setup_needed")
  );
}

function deriveStepStatus(input: {
  stepId: FirstRunStepId;
  prerequisitesMet: boolean;
  blockers: ReadinessBlocker[];
  complete: boolean;
  isCurrent: boolean;
}): FirstRunStepStatus {
  if (!input.prerequisitesMet) {
    return "not_started";
  }
  if (input.complete) {
    return "complete";
  }
  if (input.blockers.length > 0) {
    if (input.isCurrent && blockersAreSetupNeeded(input.blockers)) {
      return "in_progress";
    }
    return "blocked";
  }
  if (input.isCurrent) {
    return "in_progress";
  }
  return "ready";
}

function formatBlockerProblem(message: string): string {
  return message
    .replace(/^Blocked:\s*/, "")
    .replace(/^Setup needed:\s*/, "");
}

function derivePrimarySetupTask(input: {
  highestPriorityBlocker?: ReadinessBlocker;
  staleSmokeDiagnostics: StaleSmokeDiagnostics;
}): PrimarySetupTask | undefined {
  if (input.staleSmokeDiagnostics.hasStaleConfig) {
    const needsTargetRepo =
      input.staleSmokeDiagnostics.staleTargetRepos.length > 0;
    const suggestedRepo =
      input.staleSmokeDiagnostics.suggestedHarnessDispatchRepo;

    return {
      id: "fix-stale-smoke-config",
      stepId: "local-setup",
      title: "I need this from you now",
      problem: "Your setup points at an old disposable smoke-test repo.",
      whyItMatters:
        "That repo may have been deleted after the M5.5 smoke test, so GitHub access checks fail.",
      neededFromYou: needsTargetRepo
        ? suggestedRepo
          ? `Reset GITHUB_DISPATCH_REPOSITORY to ${suggestedRepo}, and enter the target repo you actually intend to use.`
          : "Reset the stale harness dispatch repo and enter the target repo you actually intend to use."
        : suggestedRepo
          ? `Reset GITHUB_DISPATCH_REPOSITORY to ${suggestedRepo}.`
          : "Reset the stale harness dispatch repo to your current harness repo.",
      primaryCtaLabel: "Preview setup files",
      secondaryCtaLabel: "Show technical details",
      tone: "error",
    };
  }

  if (input.highestPriorityBlocker?.id === "harness-repo-access-denied") {
    return {
      id: "confirm-harness-repo-access",
      stepId: "cloud-secrets",
      title: "I need this from you now",
      problem: formatBlockerProblem(input.highestPriorityBlocker.message),
      whyItMatters:
        "Cloud secrets setup cannot continue until the harness dispatch repo is reachable with your GitHub token.",
      neededFromYou:
        "Confirm the harness dispatch repo is the one you intend to use, or fix local setup if it is wrong.",
      primaryCtaLabel: "Connect cloud secrets",
      secondaryCtaLabel: "Show technical details",
      tone: "error",
    };
  }

  if (input.highestPriorityBlocker) {
    const isSetupNeeded = input.highestPriorityBlocker.tone === "setup_needed";
    const localSetupTitle =
      input.highestPriorityBlocker.id === "missing-config-local" ||
      input.highestPriorityBlocker.id === "config-unresolved"
        ? "Step 4 of 7 · Choose target repo"
        : input.highestPriorityBlocker.stepId === "connect-services"
          ? "Step 1 of 7 · Connect services"
          : input.highestPriorityBlocker.stepId === "linear-workspace"
            ? "Step 2 of 7 · Set up Linear workspace"
            : input.highestPriorityBlocker.stepId === "vercel-bridge"
              ? "Step 3 of 7 · Set up Vercel webhook bridge"
              : "Step 1 of 7 · Connect services";

    return {
      id: input.highestPriorityBlocker.id,
      stepId: input.highestPriorityBlocker.stepId,
      title: isSetupNeeded ? localSetupTitle : "I need this from you now",
      problem: formatBlockerProblem(input.highestPriorityBlocker.message),
      whyItMatters: isSetupNeeded
        ? "This is normal for a first-time setup. Nothing is broken yet."
        : "Setup cannot continue until this blocker is resolved.",
      neededFromYou: input.highestPriorityBlocker.action.replace(/^Next:\s*/, ""),
      primaryCtaLabel: isSetupNeeded
        ? input.highestPriorityBlocker.stepId === "cloud-secrets" ||
            input.highestPriorityBlocker.stepId === "target-workflow"
          ? input.highestPriorityBlocker.stepId === "cloud-secrets"
            ? "Connect cloud secrets"
            : "Install target repo workflow"
          : input.highestPriorityBlocker.id === "missing-config-local" ||
              input.highestPriorityBlocker.id === "config-unresolved"
            ? "Continue"
            : "Continue"
        : input.highestPriorityBlocker.action.replace(/^Next:\s*/, ""),
      secondaryCtaLabel: "Show technical details",
      tone: isSetupNeeded ? "setup_needed" : "error",
    };
  }

  return undefined;
}

export function deriveFirstRunReadiness(input: {
  summary: SetupGuiViewModel;
  remoteSummary: RemoteSetupSummary;
  uiState?: FirstRunReadinessUiState;
  staleSmokeDiagnostics?: StaleSmokeDiagnostics;
  controlPlaneContext?: ControlPlaneReadinessContext;
  harnessProvisioningSummary?: HarnessRepoProvisioningSummary;
}): FirstRunReadiness {
  const staleSmokeDiagnostics = input.staleSmokeDiagnostics ?? {
    hasStaleConfig: false,
    findings: [],
    staleTargetRepos: [],
  };

  const controlPlaneContext = input.controlPlaneContext ?? { state: null };

  const connectServicesBlockers = collectConnectServicesBlockers(
    input.summary,
    input.harnessProvisioningSummary,
  );
  const linearWorkspaceBlockers = collectLinearWorkspaceBlockers(
    controlPlaneContext,
    input.uiState,
  );
  const vercelBridgeBlockers = collectVercelBridgeBlockers(
    controlPlaneContext,
    input.uiState,
  );
  const localSetupBlockers = collectLocalSetupBlockers(
    input.summary,
    input.uiState,
    staleSmokeDiagnostics,
  );
  const localReadiness = collectLocalReadinessBlockers(input.summary);
  const rawCloudSecrets = collectCloudSecretsBlockers(
    input.summary,
    input.remoteSummary,
    input.uiState,
    staleSmokeDiagnostics,
    controlPlaneContext,
  );
  const configStateFingerprint = computeCloudSecretsConfigStateFingerprint({
    setupSummary: input.summary,
    controlPlaneContext,
  });
  const cloudSecrets = {
    blockers: filterResolvedCloudSecretsBlockers({
      blockers: rawCloudSecrets.blockers,
      evidence: input.uiState?.cloudSecretsApplyEvidence,
      currentConfigStateFingerprint: configStateFingerprint,
    }),
    warnings: rawCloudSecrets.warnings,
  };
  const targetWorkflow = collectTargetWorkflowBlockers(
    input.summary,
    input.remoteSummary,
    staleSmokeDiagnostics,
  );

  const connectServicesComplete = connectServicesBlockers.length === 0;
  const linearWorkspaceComplete = linearWorkspaceBlockers.length === 0;
  const vercelBridgeComplete = vercelBridgeBlockers.length === 0;
  const localSetupComplete =
    vercelBridgeComplete && localSetupBlockers.length === 0;
  const localReadinessBlockersCleared =
    localSetupComplete &&
    localReadiness.blockers.length === 0 &&
    input.summary.overview.readyForLocalDoctor;
  const localReadinessReviewed = input.uiState?.localReadinessReviewed ?? false;
  const localReadinessComplete =
    localReadinessBlockersCleared && localReadinessReviewed;
  const cloudSecretsBlockersCleared =
    localReadinessComplete && cloudSecrets.blockers.length === 0;
  const cloudSecretsReviewed = input.uiState?.cloudSecretsReviewed ?? false;
  const cloudSecretsComplete =
    cloudSecretsBlockersCleared && cloudSecretsReviewed;
  const targetWorkflowComplete =
    cloudSecretsComplete && targetWorkflow.blockers.length === 0;
  const readyForFirstRun = targetWorkflowComplete;

  const allBlockers = [
    ...connectServicesBlockers,
    ...linearWorkspaceBlockers,
    ...vercelBridgeBlockers,
    ...localSetupBlockers,
    ...localReadiness.blockers,
    ...cloudSecrets.blockers,
    ...targetWorkflow.blockers,
  ].sort((left, right) => left.priority - right.priority);

  const nonBlockingWarnings = [
    ...localReadiness.warnings,
    ...cloudSecrets.warnings,
    ...targetWorkflow.warnings,
  ].sort((left, right) => left.priority - right.priority);

  const currentStepId =
    !connectServicesComplete
      ? "connect-services"
      : !linearWorkspaceComplete
        ? "linear-workspace"
        : !vercelBridgeComplete
          ? "vercel-bridge"
          : !localSetupComplete
            ? "local-setup"
            : !localReadinessComplete
              ? "local-readiness"
              : !cloudSecretsComplete
                ? "cloud-secrets"
                : !targetWorkflowComplete
                  ? "target-workflow"
                  : "ready-for-first-run";

  const stepBlockers: Record<FirstRunStepId, ReadinessBlocker[]> = {
    "connect-services": connectServicesBlockers,
    "linear-workspace": linearWorkspaceBlockers,
    "vercel-bridge": vercelBridgeBlockers,
    "local-setup": localSetupBlockers,
    "local-readiness": localReadiness.blockers,
    "cloud-secrets": cloudSecrets.blockers,
    "target-workflow": targetWorkflow.blockers,
    "ready-for-first-run": readyForFirstRun
      ? []
      : [
          {
            id: "not-ready-for-first-run",
            stepId: "ready-for-first-run",
            message: "Blocked: Harness setup is not ready for a first run yet.",
            action: "Next: Complete the earlier setup steps first.",
            priority: 400,
            blocking: true,
          },
        ],
  };

  const steps: FirstRunStep[] = STEP_ORDER.map((stepId) => {
    const prerequisitesMet = stepPrerequisitesMet(
      stepId,
      connectServicesComplete,
      linearWorkspaceComplete,
      vercelBridgeComplete,
      localSetupComplete,
      localReadinessComplete,
      cloudSecretsComplete,
      targetWorkflowComplete,
    );
    const blockers = stepBlockers[stepId];
    const warnings =
      stepId === "local-readiness"
        ? localReadiness.warnings
        : stepId === "cloud-secrets"
          ? cloudSecrets.warnings
          : stepId === "target-workflow"
            ? targetWorkflow.warnings
            : [];
    const complete =
      stepId === "connect-services"
        ? connectServicesComplete
        : stepId === "linear-workspace"
          ? linearWorkspaceComplete
          : stepId === "vercel-bridge"
            ? vercelBridgeComplete
            : stepId === "local-setup"
              ? localSetupComplete
              : stepId === "local-readiness"
                ? localReadinessComplete
                : stepId === "cloud-secrets"
                  ? cloudSecretsComplete
                  : stepId === "target-workflow"
                    ? targetWorkflowComplete
                    : readyForFirstRun;
    const isCurrent = stepId === currentStepId;

    return {
      id: stepId,
      label: STEP_LABELS[stepId],
      status: deriveStepStatus({
        stepId,
        prerequisitesMet,
        blockers,
        complete,
        isCurrent,
      }),
      summary:
        stepId === "ready-for-first-run" && readyForFirstRun
          ? "Harness setup is ready for a future first run."
          : blockers[0]?.message ?? `Continue ${STEP_LABELS[stepId].toLowerCase()}.`,
      blockers,
      warnings,
      primaryAction: primaryActionForStep(stepId, allBlockers),
      inspectable: true,
      actionable: prerequisitesMet && (isCurrent || blockers.length > 0),
    };
  });

  const highestPriorityBlocker = allBlockers[0];
  const nextRecommendedAction = highestPriorityBlocker
    ? {
        id: highestPriorityBlocker.id,
        label: highestPriorityBlocker.action.replace(/^Next:\s*/, ""),
        stepId: highestPriorityBlocker.stepId,
      }
    : steps.find((step) => step.id === currentStepId)?.primaryAction;

  const primaryTask = derivePrimarySetupTask({
    highestPriorityBlocker,
    staleSmokeDiagnostics,
  });

  return {
    steps,
    currentStepId,
    highestPriorityBlocker,
    nextRecommendedAction,
    primaryTask,
    staleSmokeDiagnostics,
    remoteSetupBlockedByUpstream: remoteSetupBlockedByStaleSmoke(
      staleSmokeDiagnostics,
    ),
    readyForFirstRun,
    localReadinessBlockersCleared,
    localReadinessReviewed,
    localReadinessComplete,
    cloudSecretsBlockersCleared,
    cloudSecretsReviewed,
    nonBlockingWarnings,
    prohibitedActionsNote: PROHIBITED_ACTIONS_NOTE,
  };
}

export function projectMissingStepsFromReadiness(
  readiness: FirstRunReadiness,
): Array<{ id: string; label: string; detail: string }> {
  return readiness.steps
    .flatMap((step) => [...step.blockers, ...step.warnings])
    .filter((entry) => entry.blocking)
    .map((entry) => ({
      id: entry.id,
      label: entry.message
        .replace(/^Blocked:\s*/, "")
        .replace(/^Setup needed:\s*/, ""),
      detail: entry.action.replace(/^Next:\s*/, ""),
    }));
}
