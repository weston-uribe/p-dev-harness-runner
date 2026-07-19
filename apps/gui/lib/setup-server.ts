import "server-only";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import {
  applyLocalSetupFiles,
  applyConnectServicesEnv,
  previewConnectServicesEnv,
  previewLocalSetupFiles,
  type LocalSetupApplyResult,
  type LocalSetupFormPayload,
  type LocalSetupPreviewResult,
  type LocalEnvFormInput,
} from "@harness/setup/local-apply-actions";
import { loadConfigFormDefaults } from "@harness/setup/config-local-editor";
import { readExistingEnvFile } from "@harness/setup/env-merge";
import { resolveLocalFilePaths } from "@harness/setup/setup-state";
import {
  parseGitHubRepoSlug,
  readGitRemoteOrigin,
} from "@harness/setup/harness-dispatch-repo";
import {
  buildAuthoritativeCloudSecretsApplyEvidence,
  deriveFirstRunReadiness,
  type CloudSecretsApplyEvidence,
  type FirstRunReadiness,
} from "@harness/setup/first-run-readiness";
import {
  getSetupStateSummary,
  type SetupGuiViewModel,
} from "@harness/setup/gui-view-model";
import { createLiveGitHubRemoteSetupProvider } from "@harness/setup/github-remote-setup-live";
import { createLiveGitHubHarnessProvisioningProvider,
} from "@harness/setup/github-remote-setup-live";
import {
  applyTargetRepoProvisioning,
  previewTargetRepoProvisioning,
  type TargetRepoProvisioningApplyInput,
  type TargetRepoProvisioningApplyResult,
  type TargetRepoProvisioningPreview,
  type TargetRepoProvisioningRequest,
} from "@harness/setup/target-repo-provisioning";
import { createLiveGitHubTargetRepositoryProvider } from "@harness/setup/github-target-repository-provider-live";
import { tryCreateTargetRepoTestProvisioningProvider } from "@harness/setup/test-only-target-repo-provisioning-provider";
import type { GitHubTargetRepositoryProvider } from "@harness/setup/github-target-repository-provider";
import { tryCreateHarnessTestRemoteSetupProvider } from "@harness/setup/test-only-remote-setup-provider";
import { tryCreateHarnessTestProvisioningProvider } from "@harness/setup/test-only-provisioning-provider";
import {
  applyHarnessRepoProvisioning,
  loadHarnessRepoProvisioningSummary,
  previewHarnessRepoProvisioning,
  type HarnessRepoProvisioningApplyResult,
  type HarnessRepoProvisioningPreview,
  type HarnessRepoProvisioningSummary,
} from "@harness/setup/harness-repo-provisioning";
import {
  loadHarnessProvisioningDiagnosticReport,
  type HarnessProvisioningDiagnosticReport,
} from "@harness/setup/harness-provisioning-progress";
import { readHarnessProvisioningPendingState } from "@harness/setup/harness-provisioning-pending-state";
import { loadEmbeddedWorkspaceSnapshot } from "@harness/setup/harness-workspace-snapshot-loader.js";
import {
  captureAnalyticsEvent,
  captureProductError,
  isAnalyticsCaptureEnabled,
  registerProvisioningOperationId,
} from "@harness/observability/facade.js";
import {
  deriveConnectedToExistingManagedWorkspace,
  deriveCreatedSnapshotBackedWorkspace,
} from "@harness/observability/provisioning-analytics.js";
import {
  bucketProvisioningDurationMs,
  bucketSnapshotFileCount,
} from "@harness/observability/privacy-schema.js";
import {
  mapHarnessProvisioningStateToFailureCategory,
  productErrorCodeFromProvisioningState,
  shouldCaptureProvisioningStateAsProductError,
} from "@harness/observability/product-errors.js";
import {
  MockGitHubRemoteSetupProvider,
  type GitHubRemoteSetupProvider,
  type GitHubHarnessProvisioningProvider,
} from "@harness/setup/github-remote-provider";
import { GitHubClient } from "@harness/github/client";
import { isPackagedPDevRuntime } from "@harness/p-dev/runtime-mode";
import type { HarnessSecretOperatorInput } from "@harness/setup/harness-secret-setup";
import {
  buildManualHarnessSecretCopyValues,
  resolveHarnessSecretOperatorInput,
} from "@harness/setup/harness-secret-setup";
import {
  applyRemoteHarnessSecrets,
  applyRemoteTargetWorkflow,
  previewRemoteHarnessSecrets,
  previewRemoteTargetWorkflow,
  sanitizeRemoteHarnessSecretPreview,
} from "@harness/setup/remote-apply-actions";
import {
  buildRemoteSetupSummary,
  type RemoteSetupSummary,
} from "@harness/setup/remote-setup-summary";
import { finalizeTargetWorkflowRemote } from "@harness/setup/target-workflow-finalization";
import type {
  TargetWorkflowFinalizeInput,
  TargetWorkflowFinalizationResult,
} from "@harness/setup/target-workflow-finalization-types";
import { collectRemoteSecretInputs } from "@harness/setup/redact-secrets";
import { loadGithubTokenFromEnvLocal,
  hasGithubTokenConfigured,
} from "@harness/setup/setup-github-auth";
import { createLiveRunnerUpgradeProvider } from "@harness/setup/runner-upgrade-provider-live";
import { tryCreateHarnessTestRunnerUpgradeProvider } from "@harness/setup/test-only-runner-upgrade-provider";
import {
  acceptRunnerUpgrade,
  executeRunnerUpgradeOperation,
  loadRunnerUpgradeStatus,
  previewRunnerUpgrade,
} from "@harness/setup/runner-upgrade";
import {
  configureRunnerUpgradeWorker,
  ensureRunnerUpgradeWorkerStarted,
} from "@harness/setup/runner-upgrade-worker";
import {
  readRunnerUpgradeProgress,
  type RunnerUpgradeProgressState,
} from "@harness/setup/runner-upgrade-progress";
import type {
  RunnerUpgradeAcceptResult,
  RunnerUpgradePreviewResult,
  RunnerUpgradeStatusResult,
} from "@harness/setup/runner-upgrade-types";
import { runnerUpgradeStatusLabel } from "@harness/setup/runner-upgrade-types";
import type { RunnerUpgradeGitHubProvider } from "@harness/setup/runner-upgrade-provider";
import {
  RUNNER_UPGRADE_STATUS_PROVIDER_TIMEOUT_MS,
  RUNNER_UPGRADE_WORKER_PROVIDER_TIMEOUT_MS,
} from "@harness/setup/runner-upgrade-timeouts";
import {
  loadControlPlaneReadinessContext,
} from "@harness/setup/control-plane-readiness-server";
import {
  applyLinearSetup,
  type LinearSetupApplyResult,
  type LinearSetupPlanInput,
  type LinearSetupPreview,
} from "@harness/setup/linear-setup-apply";
import {
  loadLinearSetupProgressReport,
  type LinearSetupProgressReport,
} from "@harness/setup/linear-setup-progress";
import { buildLinearSetupSummary } from "@harness/setup/linear-setup-summary";
import {
  createLinearSetupClient,
  getLinearOrganizationSummary,
  listLinearProjects,
  listLinearTeams,
} from "@harness/setup/linear-setup-client";
import { previewLinearSetup } from "@harness/setup/linear-setup-plan";
import {
  applyLinearWorkspace,
  type LinearWorkspaceApplyResult,
  type LinearWorkspacePlanInput,
} from "@harness/setup/linear-workspace-apply";
import {
  previewLinearWorkspace,
  type LinearWorkspacePreview,
} from "@harness/setup/linear-workspace-plan";
import { computeLinearAssociationsFingerprint } from "@harness/setup/linear-workspace-migration";
import { resolveLinearAssociationsFromConfig } from "@harness/config/resolve-linear-workspace";
import { loadHarnessConfig } from "@harness/config/load-config";
import {
  applyLinearWorkspaceMigration,
  inspectLinearWorkspaceMigration,
} from "@harness/setup/linear-workspace-migration";
import { detectConfigControlPlaneDrift } from "@harness/setup/linear-workspace-drift";
import { readControlPlaneSetupState } from "@harness/setup/control-plane-setup-state";
import {
  applyVercelBridgeSetup,
  type VercelBridgeApplyResult,
  type VercelBridgePlanInput,
  type VercelBridgePreview,
} from "@harness/setup/vercel-setup-apply";
import { pollVercelBridgeRedeployVerification } from "@harness/setup/vercel-bridge-redeploy-poll";
import { buildVercelSetupSummary } from "@harness/setup/vercel-setup-summary";
import { previewVercelBridgeSetup } from "@harness/setup/vercel-setup-plan";
import {
  loadSecretFromEnvLocal,
  verifySetupService,
  type SetupServiceName,
} from "@harness/setup/service-verification";
import { assessGitHubDispatchTokenEligibility } from "@harness/setup/github-dispatch-token";
import {
  loadVercelBridgeOptions,
  loadVercelBridgeProjectsForScope,
} from "@harness/setup/vercel-bridge-options";
import type {
  RemoteHarnessSecretApplyResult,
  RemoteHarnessSecretManualCopyValues,
  RemoteHarnessSecretPreview,
  RemoteTargetWorkflowApplyResult,
  RemoteTargetWorkflowPreview,
} from "@harness/setup/remote-actions";

export interface RemoteSecretFormPayload {
  linearApiKey?: string;
  cursorApiKey?: string;
  harnessGithubToken?: string;
  manualHarnessDispatchRepo?: string;
}

export interface RemoteTargetWorkflowFormPayload {
  repoConfigId: string;
  targetRepo: string;
  productionBranch: string;
  manualHarnessDispatchRepo?: string;
}

export type ServiceConnectionSummaryStatus =
  | "missing"
  | "checking"
  | "connected"
  | "unauthorized"
  | "failed"
  | "unknown"
  | "stale";

export type ServiceConnectionSummary = {
  status: ServiceConnectionSummaryStatus;
  message?: string;
  label?: string;
  limitation?: string;
  checkedAt?: string;
};

export type ServiceConnectionSummaryMap = Record<
  "LINEAR_API_KEY" | "CURSOR_API_KEY" | "GITHUB_TOKEN" | "VERCEL_TOKEN",
  ServiceConnectionSummary
>;

function resolveCwd(): string {
  return resolveHarnessWorkspaceDir();
}

async function resolveRemoteProvider(): Promise<
  GitHubRemoteSetupProvider | undefined
> {
  const testProvider = tryCreateHarnessTestRemoteSetupProvider();
  if (testProvider) {
    return testProvider;
  }
  const token = await loadGithubTokenFromEnvLocal({ cwd: resolveCwd() });
  if (!hasGithubTokenConfigured(token)) {
    return undefined;
  }
  return createLiveGitHubRemoteSetupProvider(token!);
}

async function resolveRunnerUpgradeProvider(): Promise<
  RunnerUpgradeGitHubProvider | undefined
> {
  const testProvider = await tryCreateHarnessTestRunnerUpgradeProvider();
  if (testProvider) {
    return testProvider;
  }
  const token = await loadGithubTokenFromEnvLocal({ cwd: resolveCwd() });
  if (!hasGithubTokenConfigured(token)) {
    return undefined;
  }
  return createLiveRunnerUpgradeProvider(token!, {
    timeoutMs: RUNNER_UPGRADE_WORKER_PROVIDER_TIMEOUT_MS,
  });
}

async function resolveRunnerUpgradeStatusProvider(): Promise<
  RunnerUpgradeGitHubProvider | undefined
> {
  const testProvider = await tryCreateHarnessTestRunnerUpgradeProvider();
  if (testProvider) {
    return testProvider;
  }
  const token = await loadGithubTokenFromEnvLocal({ cwd: resolveCwd() });
  if (!hasGithubTokenConfigured(token)) {
    return undefined;
  }
  return createLiveRunnerUpgradeProvider(token!, {
    timeoutMs: RUNNER_UPGRADE_STATUS_PROVIDER_TIMEOUT_MS,
  });
}

export async function loadRunnerUpgradeStatusForGui(options?: {
  debugTimings?: boolean;
  testHangAfterStage?: import("@harness/setup/runner-upgrade-timeouts").RunnerUpgradeStatusStage;
  overallDeadlineMs?: number;
}): Promise<RunnerUpgradeStatusResult> {
  // Status must not start or await the upgrade worker. Worker starts on apply
  // and via instrumentation.ts only.
  const cwd = resolveCwd();
  const provider = await resolveRunnerUpgradeStatusProvider();
  if (!provider) {
    return {
      status: "failed",
      statusLabel: runnerUpgradeStatusLabel("failed"),
      blockedReason:
        "GITHUB_TOKEN is required to check or update the managed p-dev runner.",
      retryAvailable: true,
    };
  }
  return loadRunnerUpgradeStatus(cwd, provider, {
    debugTimings: options?.debugTimings === true,
    testHangAfterStage: options?.testHangAfterStage,
    overallDeadlineMs: options?.overallDeadlineMs,
    workspaceKey: cwd,
  });
}

function ensureRunnerUpgradeGuiWorkerConfigured(): void {
  configureRunnerUpgradeWorker({
    resolveProvider: async () => resolveRunnerUpgradeProvider(),
    execute: async (cwd, provider) =>
      executeRunnerUpgradeOperation(cwd, provider, {}),
  });
  ensureRunnerUpgradeWorkerStarted();
}

export async function previewRunnerUpgradeForGui(): Promise<RunnerUpgradePreviewResult> {
  const provider = await resolveRunnerUpgradeProvider();
  if (!provider) {
    return {
      previewFingerprint: "",
      targetSnapshotContentId: "",
      phases: [],
      blocked: true,
      blockedStatus: "failed",
      message:
        "GITHUB_TOKEN is required to preview a managed p-dev runner upgrade.",
      impact: {
        replacePathCount: 0,
        deletePathCount: 0,
        sampleReplacePaths: [],
        sampleDeletePaths: [],
      },
    };
  }
  return previewRunnerUpgrade(resolveCwd(), provider);
}

export async function applyRunnerUpgradeForGui(options: {
  confirmed: boolean;
  previewFingerprint?: string;
  resume?: boolean;
}): Promise<{
  apply: RunnerUpgradeAcceptResult;
  progress: RunnerUpgradeProgressState;
  status: RunnerUpgradeStatusResult;
}> {
  if (!options.confirmed) {
    throw new Error("Confirmed apply is required.");
  }
  ensureRunnerUpgradeGuiWorkerConfigured();
  const tokenPresent = await resolveRunnerUpgradeProvider();
  if (!tokenPresent) {
    throw new Error(
      "GITHUB_TOKEN is required to apply a managed p-dev runner upgrade.",
    );
  }
  const accepted = await acceptRunnerUpgrade(resolveCwd(), {
    previewFingerprint: options.previewFingerprint,
    resume: options.resume === true,
  });
  return {
    apply: accepted.apply,
    progress: accepted.progress,
    status: {
      status: "updating",
      statusLabel: runnerUpgradeStatusLabel("updating"),
      pendingOperationId: accepted.apply.operationId,
      pendingPhase: accepted.apply.phase,
    },
  };
}

export async function loadRunnerUpgradeProgressForGui(): Promise<RunnerUpgradeProgressState | null> {
  return readRunnerUpgradeProgress(resolveCwd());
}

function toOperatorInput(
  payload: RemoteSecretFormPayload,
): HarnessSecretOperatorInput {
  const explicitCredentialReplacements: HarnessSecretOperatorInput["explicitCredentialReplacements"] =
    [];
  if (payload.linearApiKey?.trim()) {
    explicitCredentialReplacements.push("LINEAR_API_KEY");
  }
  if (payload.cursorApiKey?.trim()) {
    explicitCredentialReplacements.push("CURSOR_API_KEY");
  }
  if (payload.harnessGithubToken?.trim()) {
    explicitCredentialReplacements.push("HARNESS_GITHUB_TOKEN");
  }

  return {
    linearApiKey: payload.linearApiKey,
    cursorApiKey: payload.cursorApiKey,
    githubToken: payload.harnessGithubToken,
    explicitCredentialReplacements:
      explicitCredentialReplacements.length > 0
        ? explicitCredentialReplacements
        : undefined,
  };
}

async function resolveEnrichedHarnessSecretOperatorInput(
  payload: RemoteSecretFormPayload,
): Promise<HarnessSecretOperatorInput> {
  const cwd = resolveCwd();
  const explicit = toOperatorInput(payload);
  const enriched = await resolveHarnessSecretOperatorInput({
    cwd,
    payload,
  });

  return {
    linearApiKey: explicit.linearApiKey?.trim() || enriched.linearApiKey,
    cursorApiKey: explicit.cursorApiKey?.trim() || enriched.cursorApiKey,
    githubToken: explicit.githubToken?.trim() || enriched.githubToken,
    explicitCredentialReplacements: explicit.explicitCredentialReplacements,
    credentialInputSources: enriched.credentialInputSources,
  };
}

export async function loadSetupSummary(): Promise<SetupGuiViewModel> {
  return getSetupStateSummary({ cwd: resolveCwd() });
}

export async function loadRemoteSetupSummary(): Promise<RemoteSetupSummary> {
  const cwd = resolveCwd();
  const provider = await resolveRemoteProvider();
  return buildRemoteSetupSummary({ cwd, provider });
}

export async function loadFirstRunReadiness(): Promise<FirstRunReadiness> {
  const [summary, remoteSummary, harnessProvisioningSummary] = await Promise.all([
    loadSetupSummary(),
    loadRemoteSetupSummary(),
    loadHarnessRepoProvisioningSummaryRemote(),
  ]);
  const controlPlaneContext = await loadControlPlaneReadinessContext(
    resolveCwd(),
    summary,
  );
  return deriveFirstRunReadiness({
    summary,
    remoteSummary,
    staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
    controlPlaneContext,
    harnessProvisioningSummary,
  });
}

export async function loadSetupFormDefaults(): Promise<{
  env: {
    harnessConfigPath: string;
    githubDispatchRepository: string;
    suggestedHarnessDispatchRepo?: string;
    secretPresence: {
      LINEAR_API_KEY: boolean;
      CURSOR_API_KEY: boolean;
      GITHUB_TOKEN: boolean;
      VERCEL_TOKEN: boolean;
    };
    serviceConnectionSummaries: ServiceConnectionSummaryMap;
  };
  config: Awaited<ReturnType<typeof loadConfigFormDefaults>>;
}> {
  const cwd = resolveCwd();
  const paths = resolveLocalFilePaths(cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const config = await loadConfigFormDefaults({ cwd });
  const gitRemoteOriginUrl = isPackagedPDevRuntime()
    ? null
    : await readGitRemoteOrigin(cwd);
  const suggestedHarnessDispatchRepo = gitRemoteOriginUrl
    ? parseGitHubRepoSlug(gitRemoteOriginUrl) ?? undefined
    : undefined;

  const secretPresence = {
    LINEAR_API_KEY: existingEnv?.presence.LINEAR_API_KEY ?? false,
    CURSOR_API_KEY: existingEnv?.presence.CURSOR_API_KEY ?? false,
    GITHUB_TOKEN: existingEnv?.presence.GITHUB_TOKEN ?? false,
    VERCEL_TOKEN: existingEnv?.presence.VERCEL_TOKEN ?? false,
  };

  return {
    env: {
      harnessConfigPath:
        existingEnv?.values.HARNESS_CONFIG_PATH ?? ".harness/config.local.json",
      githubDispatchRepository:
        existingEnv?.values.GITHUB_DISPATCH_REPOSITORY ?? "",
      suggestedHarnessDispatchRepo,
      secretPresence,
      serviceConnectionSummaries: await loadServiceConnectionSummaries(
        cwd,
        secretPresence,
      ),
    },
    config,
  };
}

const SERVICE_SUMMARY_MAP: Record<
  keyof ServiceConnectionSummaryMap,
  SetupServiceName
> = {
  LINEAR_API_KEY: "linear",
  CURSOR_API_KEY: "cursor",
  GITHUB_TOKEN: "github",
  VERCEL_TOKEN: "vercel",
};

async function loadServiceConnectionSummaries(
  cwd: string,
  presence: Record<keyof ServiceConnectionSummaryMap, boolean>,
): Promise<ServiceConnectionSummaryMap> {
  const entries = await Promise.all(
    (Object.keys(SERVICE_SUMMARY_MAP) as Array<keyof ServiceConnectionSummaryMap>).map(
      async (key) => {
        if (!presence[key]) {
          return [key, { status: "missing" as const }] as const;
        }

        try {
          const result = await verifySetupService({
            cwd,
            service: SERVICE_SUMMARY_MAP[key],
          });
          return [
            key,
            {
              status: result.status,
              message: result.message,
              label: result.label,
              limitation: result.limitation,
              checkedAt: new Date().toISOString(),
            },
          ] as const;
        } catch (error) {
          const raw =
            error instanceof Error
              ? error.message
              : "Saved credential could not be verified.";
          return [
            key,
            {
              status: "unknown" as const,
              message:
                /LINEAR_API_KEY=|CURSOR_API_KEY=|GITHUB_TOKEN=|VERCEL_TOKEN=|\.env\.local/i.test(
                  raw,
                )
                  ? "Saved credential could not be verified."
                  : raw,
              checkedAt: new Date().toISOString(),
            },
          ] as const;
        }
      },
    ),
  );

  return Object.fromEntries(entries) as ServiceConnectionSummaryMap;
}

export async function previewLocalFiles(
  payload: LocalSetupFormPayload,
): Promise<LocalSetupPreviewResult> {
  return previewLocalSetupFiles({
    cwd: resolveCwd(),
    payload,
  });
}

export async function applyLocalFiles(options: {
  payload: LocalSetupFormPayload;
  confirmed: boolean;
  fingerprint: string;
}): Promise<{
  apply: LocalSetupApplyResult;
  summary: SetupGuiViewModel;
}> {
  const cwd = resolveCwd();
  const apply = await applyLocalSetupFiles({
    cwd,
    payload: options.payload,
    confirmed: options.confirmed,
    fingerprint: options.fingerprint,
  });
  const summary = await getSetupStateSummary({ cwd });
  return { apply, summary };
}

export async function previewHarnessSecretsRemote(
  payload: RemoteSecretFormPayload,
): Promise<RemoteHarnessSecretPreview> {
  const operatorInput = await resolveEnrichedHarnessSecretOperatorInput(payload);
  const knownSecrets = collectRemoteSecretInputs(operatorInput);
  const preview = await previewRemoteHarnessSecrets({
    cwd: resolveCwd(),
    operatorInput,
    manualHarnessDispatchRepo: payload.manualHarnessDispatchRepo,
    provider: await resolveRemoteProvider(),
  });
  return sanitizeRemoteHarnessSecretPreview(preview, knownSecrets);
}

export async function applyHarnessSecretsRemote(options: {
  payload: RemoteSecretFormPayload;
  confirmed: boolean;
  fingerprint: string;
}): Promise<{
  apply: RemoteHarnessSecretApplyResult;
  summary: RemoteSetupSummary;
  evidence: CloudSecretsApplyEvidence;
}> {
  const cwd = resolveCwd();
  const operatorInput = await resolveEnrichedHarnessSecretOperatorInput(
    options.payload,
  );
  const apply = await applyRemoteHarnessSecrets({
    cwd,
    operatorInput,
    manualHarnessDispatchRepo: options.payload.manualHarnessDispatchRepo,
    confirmed: options.confirmed,
    fingerprint: options.fingerprint,
    provider: await resolveRemoteProvider(),
  });
  const [summary, setupSummary] = await Promise.all([
    loadRemoteSetupSummary(),
    loadSetupSummary(),
  ]);
  const controlPlaneContext = await loadControlPlaneReadinessContext(
    cwd,
    setupSummary,
  );
  const evidence = buildAuthoritativeCloudSecretsApplyEvidence({
    applyResult: apply,
    setupSummary,
    controlPlaneContext,
    remoteSummary: summary,
  });
  return { apply, summary, evidence };
}

export async function previewTargetWorkflowRemote(
  payload: RemoteTargetWorkflowFormPayload,
): Promise<RemoteTargetWorkflowPreview> {
  return previewRemoteTargetWorkflow({
    cwd: resolveCwd(),
    repoConfigId: payload.repoConfigId,
    targetRepo: payload.targetRepo,
    productionBranch: payload.productionBranch,
    manualHarnessDispatchRepo: payload.manualHarnessDispatchRepo,
    provider: await resolveRemoteProvider(),
  });
}

export async function applyTargetWorkflowRemote(options: {
  payload: RemoteTargetWorkflowFormPayload;
  confirmed: boolean;
  fingerprint: string;
}): Promise<{
  apply: RemoteTargetWorkflowApplyResult;
  summary: RemoteSetupSummary;
  finalization?: TargetWorkflowFinalizationResult;
}> {
  const provider = await resolveRemoteProvider();
  const apply = await applyRemoteTargetWorkflow({
    cwd: resolveCwd(),
    repoConfigId: options.payload.repoConfigId,
    targetRepo: options.payload.targetRepo,
    productionBranch: options.payload.productionBranch,
    manualHarnessDispatchRepo: options.payload.manualHarnessDispatchRepo,
    confirmed: options.confirmed,
    fingerprint: options.fingerprint,
    provider,
  });

  let finalization: TargetWorkflowFinalizationResult | undefined;
  if (
    provider &&
    apply.outcome !== "already-installed" &&
    (apply.outcome === "pr-created" ||
      apply.outcome === "pr-updated" ||
      apply.outcome === "branch-updated")
  ) {
    finalization = await runTargetWorkflowFinalization({
      provider,
      input: {
        repoConfigId: options.payload.repoConfigId,
        targetRepo: options.payload.targetRepo,
        productionBranch: options.payload.productionBranch,
        manualHarnessDispatchRepo: options.payload.manualHarnessDispatchRepo,
        prUrl: apply.prUrl,
        branchName: apply.branchName,
      },
    });
  }

  const summary = await loadRemoteSetupSummary();
  return { apply, summary, finalization };
}

export async function finalizeTargetWorkflowRemoteAction(
  payload: RemoteTargetWorkflowFormPayload & {
    prUrl?: string;
    branchName?: string;
    operationId?: string;
  },
): Promise<{
  finalization: TargetWorkflowFinalizationResult;
  summary: RemoteSetupSummary;
}> {
  const provider = await resolveRemoteProvider();
  if (!provider) {
    throw new Error("GitHub token is required for target workflow finalization");
  }

  const finalization = await runTargetWorkflowFinalization({
    provider,
    input: {
      repoConfigId: payload.repoConfigId,
      targetRepo: payload.targetRepo,
      productionBranch: payload.productionBranch,
      manualHarnessDispatchRepo: payload.manualHarnessDispatchRepo,
      prUrl: payload.prUrl,
      branchName: payload.branchName,
      operationId: payload.operationId,
    },
  });
  const summary = await loadRemoteSetupSummary();
  return { finalization, summary };
}

async function runTargetWorkflowFinalization(options: {
  provider: GitHubRemoteSetupProvider;
  input: TargetWorkflowFinalizeInput;
}): Promise<TargetWorkflowFinalizationResult> {
  if (options.provider instanceof MockGitHubRemoteSetupProvider) {
    return options.provider.advanceTargetWorkflowFinalization(options.input);
  }

  const cwd = resolveCwd();
  const token = await loadGithubTokenFromEnvLocal({ cwd });
  if (!hasGithubTokenConfigured(token)) {
    throw new Error("GitHub token is required for target workflow finalization");
  }

  const client = new GitHubClient({ token: token! });
  return finalizeTargetWorkflowRemote({
    cwd,
    input: options.input,
    provider: options.provider,
    client,
  });
}

async function loadLinearApiKey(cwd: string): Promise<string | undefined> {
  return loadSecretFromEnvLocal({ cwd, key: "LINEAR_API_KEY" });
}

async function loadVercelToken(cwd: string): Promise<string | undefined> {
  return loadSecretFromEnvLocal({ cwd, key: "VERCEL_TOKEN" });
}

async function enrichVercelBridgePlan(
  cwd: string,
  plan: Omit<VercelBridgePlanInput, "vercelToken" | "linearApiKey"> & {
    vercelToken?: string;
    linearApiKey?: string;
  },
): Promise<VercelBridgePlanInput> {
  const vercelToken = plan.vercelToken ?? (await loadVercelToken(cwd)) ?? "";
  const linearApiKey = plan.linearApiKey ?? (await loadLinearApiKey(cwd));
  const githubToken = await loadSecretFromEnvLocal({ cwd, key: "GITHUB_TOKEN" });
  const controlPlane = await readControlPlaneSetupState(cwd);
  const harnessProvisioningSummary = await loadHarnessRepoProvisioningSummaryRemote();
  const dispatchEligibility = await assessGitHubDispatchTokenEligibility({
    githubToken,
    cwd,
    harnessProvisioningSummary,
    requireVerifiedPackagedDispatchRepo: true,
  });
  const savedWebhookSecret = await loadSecretFromEnvLocal({
    cwd,
    key: "LINEAR_WEBHOOK_SECRET",
  });
  const hasOperatorWebhookSecret = Boolean(plan.envInput?.LINEAR_WEBHOOK_SECRET?.trim());
  const hasSavedLocalWebhookSecret = Boolean(savedWebhookSecret?.trim());
  const reuseSavedLocalWebhookSecret =
    !hasOperatorWebhookSecret && hasSavedLocalWebhookSecret;

  return {
    ...plan,
    vercelToken,
    linearApiKey,
    linearTeamId: plan.linearTeamId ?? controlPlane?.linear?.teamId,
    derivedHarnessTeamKey:
      plan.derivedHarnessTeamKey ?? controlPlane?.linear?.teamKey,
    derivedGithubDispatchToken:
      plan.envInput?.GITHUB_DISPATCH_TOKEN?.trim() || !dispatchEligibility.eligible
        ? undefined
        : githubToken,
    derivedGithubDispatchRepository: dispatchEligibility.eligible
      ? dispatchEligibility.repository
      : undefined,
    willGenerateLinearWebhookSecret: reuseSavedLocalWebhookSecret
      ? true
      : (plan.willGenerateLinearWebhookSecret ?? !hasOperatorWebhookSecret),
    verificationLinearWebhookSecret:
      plan.verificationLinearWebhookSecret ?? savedWebhookSecret,
    preserveGeneratedWebhookSecretFingerprint:
      plan.preserveGeneratedWebhookSecretFingerprint ?? reuseSavedLocalWebhookSecret,
  };
}

export async function loadLinearSetupSummary() {
  return buildLinearSetupSummary(resolveCwd());
}

export async function loadLinearWorkspaceOptions(): Promise<{
  workspaceId: string;
  workspaceName: string;
  teams: Awaited<ReturnType<typeof listLinearTeams>>;
  projects: Awaited<ReturnType<typeof listLinearProjects>>;
}> {
  const cwd = resolveCwd();
  const linearApiKey = await loadLinearApiKey(cwd);
  if (!linearApiKey?.trim()) {
    throw new Error("LINEAR_API_KEY is required to load Linear workspace options.");
  }
  const client = createLinearSetupClient(linearApiKey);
  const [organization, teams, projects] = await Promise.all([
    getLinearOrganizationSummary(client),
    listLinearTeams(client),
    listLinearProjects(client),
  ]);
  return {
    workspaceId: organization.id,
    workspaceName: organization.name,
    teams,
    projects,
  };
}

export async function loadVercelSetupSummary() {
  return buildVercelSetupSummary(resolveCwd());
}

export async function previewLinearSetupRemote(
  payload: Omit<LinearSetupPlanInput, "linearApiKey"> & {
    linearApiKey?: string;
  },
): Promise<LinearSetupPreview> {
  const cwd = resolveCwd();
  const linearApiKey =
    payload.linearApiKey ?? (await loadLinearApiKey(cwd)) ?? "";
  return previewLinearSetup({
    ...payload,
    linearApiKey,
  });
}

export async function applyLinearSetupRemote(options: {
  plan: Omit<LinearSetupPlanInput, "linearApiKey"> & { linearApiKey?: string };
  confirmed: boolean;
  fingerprint: string;
}): Promise<{
  apply: LinearSetupApplyResult;
  summary: Awaited<ReturnType<typeof buildLinearSetupSummary>>;
}> {
  const cwd = resolveCwd();
  const linearApiKey =
    options.plan.linearApiKey ?? (await loadLinearApiKey(cwd)) ?? "";
  const apply = await applyLinearSetup({
    plan: { ...options.plan, linearApiKey },
    confirmed: options.confirmed,
    fingerprint: options.fingerprint,
    cwd,
  });
  const summary = await buildLinearSetupSummary(cwd);
  return { apply, summary };
}

export async function loadLinearSetupProgressRemote(): Promise<LinearSetupProgressReport> {
  return loadLinearSetupProgressReport(resolveCwd());
}

export async function ensureLinearWorkspaceMigrated(cwd = resolveCwd()) {
  const inspection = await inspectLinearWorkspaceMigration({ cwd });
  if (inspection.status !== "nothing_to_migrate") {
    return inspection;
  }

  const linearApiKey = (await loadLinearApiKey(cwd)) ?? "";
  if (!linearApiKey) {
    return inspection;
  }

  const controlPlane = await readControlPlaneSetupState(cwd);
  if (!controlPlane?.linear?.teamId) {
    return inspection;
  }

  const client = createLinearSetupClient(linearApiKey);
  const organization = await getLinearOrganizationSummary(client);
  const candidateInspection = await inspectLinearWorkspaceMigration({
    cwd,
    workspaceId: organization.id,
    workspaceName: organization.name,
  });
  if (candidateInspection.status !== "candidate") {
    return candidateInspection;
  }

  return applyLinearWorkspaceMigration({
    cwd,
    workspaceId: organization.id,
    workspaceName: organization.name,
    candidate: candidateInspection.candidate,
  });
}

export async function loadLinearWorkspaceEditorState(cwd = resolveCwd()) {
  await ensureLinearWorkspaceMigrated(cwd);
  const summary = await buildLinearSetupSummary(cwd);
  const loaded = await loadHarnessConfig({ baseDir: cwd });
  const controlPlane = await readControlPlaneSetupState(cwd);
  const associations = resolveLinearAssociationsFromConfig(loaded.config);
  const expectedCommittedFingerprint = computeLinearAssociationsFingerprint(
    loaded.config,
  );
  const evidence = summary.controlPlane?.linearWorkspace;
  const driftWarnings = detectConfigControlPlaneDrift({
    config: loaded.config,
    controlPlane,
  });
  return {
    summary,
    associations,
    repos: loaded.config.repos.map((repo) => ({
      id: repo.id,
      targetRepo: repo.targetRepo,
    })),
    expectedCommittedFingerprint,
    workspaceId:
      loaded.config.linear?.workspaceId ?? evidence?.workspaceId ?? "",
    workspaceName: evidence?.workspaceName ?? "Linear workspace",
    driftWarnings,
  };
}

export async function previewLinearWorkspaceRemote(
  payload: Omit<
    LinearWorkspacePlanInput,
    "linearApiKey" | "expectedCommittedFingerprint"
  > & {
    linearApiKey?: string;
    expectedCommittedFingerprint: string;
  },
): Promise<LinearWorkspacePreview> {
  const cwd = resolveCwd();
  const linearApiKey =
    payload.linearApiKey ?? (await loadLinearApiKey(cwd)) ?? "";
  return previewLinearWorkspace({
    ...payload,
    linearApiKey,
    cwd,
  });
}

export async function applyLinearWorkspaceRemote(options: {
  plan: Omit<
    LinearWorkspacePlanInput,
    "linearApiKey" | "expectedCommittedFingerprint"
  > & {
    linearApiKey?: string;
    expectedCommittedFingerprint: string;
  };
  confirmed: boolean;
  fingerprint?: string;
}): Promise<{
  apply: LinearWorkspaceApplyResult;
  summary: Awaited<ReturnType<typeof buildLinearSetupSummary>>;
  expectedCommittedFingerprint: string;
}> {
  const cwd = resolveCwd();
  const linearApiKey =
    options.plan.linearApiKey ?? (await loadLinearApiKey(cwd)) ?? "";
  const apply = await applyLinearWorkspace({
    plan: { ...options.plan, linearApiKey, cwd },
    confirmed: options.confirmed,
    fingerprint: options.fingerprint,
    cwd,
  });
  const summary = await buildLinearSetupSummary(cwd);
  const loaded = await loadHarnessConfig({ baseDir: cwd });
  return {
    apply,
    summary,
    expectedCommittedFingerprint: computeLinearAssociationsFingerprint(
      loaded.config,
    ),
  };
}

export async function loadVercelBridgeOptionsRemote(input?: {
  teamId?: string;
}) {
  const cwd = resolveCwd();
  const vercelToken = (await loadVercelToken(cwd)) ?? "";
  const githubToken = await loadSecretFromEnvLocal({ cwd, key: "GITHUB_TOKEN" });
  const harnessProvisioningSummary = await loadHarnessRepoProvisioningSummaryRemote();
  return loadVercelBridgeOptions({
    vercelToken,
    githubToken,
    cwd,
    teamId: input?.teamId,
    harnessProvisioningSummary,
  });
}

export async function loadVercelBridgeProjectsRemote(teamId?: string) {
  const cwd = resolveCwd();
  const vercelToken = (await loadVercelToken(cwd)) ?? "";
  return loadVercelBridgeProjectsForScope({ vercelToken, teamId });
}

export async function previewVercelBridgeRemote(
  payload: Omit<VercelBridgePlanInput, "vercelToken" | "linearApiKey"> & {
    vercelToken?: string;
    linearApiKey?: string;
  },
): Promise<VercelBridgePreview> {
  const cwd = resolveCwd();
  const plan = await enrichVercelBridgePlan(cwd, payload);
  return previewVercelBridgeSetup(plan);
}

export async function applyVercelBridgeRemote(options: {
  plan: Omit<VercelBridgePlanInput, "vercelToken" | "linearApiKey"> & {
    vercelToken?: string;
    linearApiKey?: string;
  };
  confirmed: boolean;
  fingerprint: string;
  manualComplete?: boolean;
  verifyOnly?: boolean;
}): Promise<{
  apply: VercelBridgeApplyResult;
  summary: Awaited<ReturnType<typeof buildVercelSetupSummary>>;
}> {
  const cwd = resolveCwd();
  const plan = await enrichVercelBridgePlan(cwd, options.plan);
  const apply = await applyVercelBridgeSetup({
    plan,
    confirmed: options.confirmed,
    fingerprint: options.fingerprint,
    manualComplete: options.manualComplete,
    verifyOnly: options.verifyOnly,
    cwd,
  });
  const summary = await buildVercelSetupSummary(cwd);
  return { apply, summary };
}

export async function pollVercelBridgeRedeployRemote(options: {
  actionId?: string;
}): Promise<{
  apply: VercelBridgeApplyResult;
  summary: Awaited<ReturnType<typeof buildVercelSetupSummary>>;
}> {
  const cwd = resolveCwd();
  const apply = await pollVercelBridgeRedeployVerification({
    actionId: options.actionId,
    cwd,
  });
  const summary = await buildVercelSetupSummary(cwd);
  return { apply, summary };
}

async function resolveProvisioningProvider(): Promise<
  GitHubHarnessProvisioningProvider | undefined
> {
  const testProvider = tryCreateHarnessTestProvisioningProvider();
  if (testProvider) {
    return testProvider;
  }
  const token = await loadGithubTokenFromEnvLocal({ cwd: resolveCwd() });
  if (!hasGithubTokenConfigured(token)) {
    return undefined;
  }
  return createLiveGitHubHarnessProvisioningProvider(token!);
}

export async function loadHarnessRepoProvisioningSummaryRemote(): Promise<HarnessRepoProvisioningSummary> {
  const provider = await resolveProvisioningProvider();
  return loadHarnessRepoProvisioningSummary({
    cwd: resolveCwd(),
    provider,
  });
}

export async function loadHarnessProvisioningDiagnosticRemote(): Promise<HarnessProvisioningDiagnosticReport> {
  const cwd = resolveCwd();
  const pending = await readHarnessProvisioningPendingState(cwd);
  return loadHarnessProvisioningDiagnosticReport({ cwd, pending });
}

export async function previewHarnessRepoProvisioningRemote(options?: {
  operationId?: string;
}): Promise<HarnessRepoProvisioningPreview> {
  const provider = await resolveProvisioningProvider();
  if (!provider) {
    return {
      state: "token-unavailable",
      fingerprint: JSON.stringify({ action: "preview", tokenUnavailable: true }),
      operationId: options?.operationId ?? randomUUID(),
      creationPreviewFingerprint: null,
      resumedFromPending: false,
      harnessDispatchRepo: null,
      authenticatedLogin: null,
      packageName: "p-dev-harness",
      packageVersion: "",
      sourceRepository: "",
      sourceCommit: "",
      snapshotContentId: null,
      snapshotFingerprint: null,
      templateContentId: null,
      message: "GITHUB_TOKEN is required before provisioning a harness workspace.",
      recoverable: true,
      willCreateRepository: false,
      tokenCapabilities: {
        tokenType: "unknown",
        hasRepoScope: false,
        hasWorkflowScope: false,
        scopeAmbiguous: true,
      },
    };
  }

  return previewHarnessRepoProvisioning({
    cwd: resolveCwd(),
    provider,
    operationId: options?.operationId,
  });
}

export async function applyHarnessRepoProvisioningRemote(options: {
  confirmed: boolean;
  fingerprint: string;
  operationId: string;
}): Promise<{
  apply: HarnessRepoProvisioningApplyResult;
  summary: SetupGuiViewModel;
  provisioning: HarnessRepoProvisioningPreview;
}> {
  const provider = await resolveProvisioningProvider();
  if (!provider) {
    throw new Error(
      "GITHUB_TOKEN is required before provisioning a harness workspace.",
    );
  }

  const provisioning = await previewHarnessRepoProvisioning({
    cwd: resolveCwd(),
    provider,
    operationId: options.operationId,
  });

  registerProvisioningOperationId(options.operationId);

  let snapshotFileCountBucket = "unknown";
  if (isAnalyticsCaptureEnabled()) {
    const snapshotPreview = await loadEmbeddedWorkspaceSnapshot(import.meta.url);
    snapshotFileCountBucket = snapshotPreview.ok
      ? bucketSnapshotFileCount(snapshotPreview.manifest.fileCount)
      : "unknown";

    captureAnalyticsEvent({
      type: "p_dev_workspace_provision_started",
      snapshotFileCountBucket,
      resumedFromDurablePendingState: provisioning.resumedFromPending,
    });
  }

  const startedAt = Date.now();
  const apply = await applyHarnessRepoProvisioning({
    cwd: resolveCwd(),
    provider,
    confirmed: options.confirmed,
    fingerprint: options.fingerprint,
    operationId: options.operationId,
  });

  if (isAnalyticsCaptureEnabled()) {
    const durationBucket = bucketProvisioningDurationMs(Date.now() - startedAt);

    if (apply.persisted) {
      captureAnalyticsEvent({
        type: "p_dev_workspace_provision_completed",
        snapshotFileCountBucket,
        durationBucket,
        retryCountBucket: "unknown",
        rateLimitPauseCountBucket: "unknown",
        outcome: "success",
        resumedFromDurablePendingState: provisioning.resumedFromPending,
        connectedToExistingLegacyWorkspace:
          deriveConnectedToExistingManagedWorkspace({
            persisted: apply.persisted,
            previewState: provisioning.state,
          }),
        createdSnapshotBackedWorkspace: deriveCreatedSnapshotBackedWorkspace({
          persisted: apply.persisted,
          applyState: apply.state,
          preview: provisioning,
        }),
      });
    } else {
      const failureCategory = mapHarnessProvisioningStateToFailureCategory(
        apply.state,
      );
      captureAnalyticsEvent({
        type: "p_dev_workspace_provision_failed",
        snapshotFileCountBucket,
        durationBucket,
        retryCountBucket: "unknown",
        rateLimitPauseCountBucket: "unknown",
        failureCategory,
        resumedFromDurablePendingState: provisioning.resumedFromPending,
        recoveryStateRemainedAfterFailure: apply.recoverable,
      });
      if (shouldCaptureProvisioningStateAsProductError(apply.state)) {
        captureProductError({
          lifecyclePhase: "provisioning",
          productErrorCode: productErrorCodeFromProvisioningState(apply.state),
          errorCategory: failureCategory,
        });
      }
    }
  } else if (shouldCaptureProvisioningStateAsProductError(apply.state)) {
    const failureCategory = mapHarnessProvisioningStateToFailureCategory(
      apply.state,
    );
    captureProductError({
      lifecyclePhase: "provisioning",
      productErrorCode: productErrorCodeFromProvisioningState(apply.state),
      errorCategory: failureCategory,
    });
  }

  const summary = await getSetupStateSummary({ cwd: resolveCwd() });
  return { apply, summary, provisioning };
}

export async function verifyHarnessRepoAccessRemote(options: {
  harnessDispatchRepo: string;
  githubToken?: string;
}): Promise<{
  status: "connected" | "failed" | "unknown";
  repoSlug: string;
  message: string;
  limitation?: string;
}> {
  const cwd = resolveCwd();
  const repoSlug = parseGitHubRepoSlug(options.harnessDispatchRepo.trim());
  if (!repoSlug) {
    return {
      status: "failed",
      repoSlug: options.harnessDispatchRepo.trim(),
      message: "Enter a valid GitHub repo slug or URL (owner/repo).",
    };
  }

  const token =
    options.githubToken?.trim() ||
    (await loadGithubTokenFromEnvLocal({ cwd }));
  if (!token) {
    return {
      status: "failed",
      repoSlug,
      message:
        "GITHUB_TOKEN is required to verify harness repo access. Add it in Step 1 first.",
    };
  }

  const provider = createLiveGitHubRemoteSetupProvider(token);
  const access = await provider.checkHarnessRepoAccess(repoSlug);
  if (access === "available") {
    return {
      status: "connected",
      repoSlug,
      message: `Connected to ${repoSlug}.`,
      limitation:
        "This check confirms GitHub access only. Saving still happens when you create or update local setup files.",
    };
  }
  if (access === "denied") {
    return {
      status: "failed",
      repoSlug,
      message: `GitHub denied access to ${repoSlug}.`,
      limitation:
        "Confirm this is the harness repo you intend to use and that your GitHub token has admin or maintain access.",
    };
  }

  return {
    status: "unknown",
    repoSlug,
    message: `Harness repo access for ${repoSlug} could not be verified yet.`,
    limitation: "Retry after saving GITHUB_TOKEN in Step 1.",
  };
}

export async function loadManualHarnessSecretCopyValues(): Promise<
  import("@harness/setup/remote-actions").RemoteHarnessSecretManualCopyValues
> {
  return buildManualHarnessSecretCopyValues({ cwd: resolveCwd() });
}

export async function previewConnectServicesRemote(
  env: LocalEnvFormInput,
): Promise<Awaited<ReturnType<typeof previewConnectServicesEnv>>> {
  return previewConnectServicesEnv({ cwd: resolveCwd(), env });
}

export async function applyConnectServicesRemote(options: {
  env: LocalEnvFormInput;
  confirmed: boolean;
  fingerprint: string;
}): Promise<{ summary: SetupGuiViewModel }> {
  const cwd = resolveCwd();
  await applyConnectServicesEnv({
    cwd,
    env: options.env,
    confirmed: options.confirmed,
    fingerprint: options.fingerprint,
  });
  const summary = await getSetupStateSummary({ cwd });
  return { summary };
}

async function resolveTargetRepoProvisioningProvider(): Promise<
  GitHubTargetRepositoryProvider | undefined
> {
  const testProvider = tryCreateTargetRepoTestProvisioningProvider();
  if (testProvider) {
    return testProvider;
  }
  const token = await loadGithubTokenFromEnvLocal({ cwd: resolveCwd() });
  if (!hasGithubTokenConfigured(token)) {
    return undefined;
  }
  return createLiveGitHubTargetRepositoryProvider(token!);
}

export async function previewTargetRepoProvisioningRemote(
  request: TargetRepoProvisioningRequest,
): Promise<TargetRepoProvisioningPreview> {
  const provider = await resolveTargetRepoProvisioningProvider();
  if (!provider) {
    return {
      state: "invalid-input",
      fingerprint: "",
      operationId: request.operationId ?? "",
      creationActionId: request.creationActionId ?? "",
      createdAt: request.createdAt ?? "",
      owner: request.owner,
      repositoryName: request.name,
      repositoryFullName: `${request.owner}/${request.name}`,
      visibility: request.visibility ?? "private",
      description: request.description ?? "",
      initialBranches: ["main", "dev"],
      initialFilePaths: ["README.md", ".p-dev/product.json"],
      resultingTargetRepoConfigId: `target-${request.name}`,
      actionsWillPerform: [],
      actionsWillNotPerform: [],
      message: "GITHUB_TOKEN is required before creating a product repository.",
      resumedFromPending: false,
    };
  }
  return previewTargetRepoProvisioning({
    request,
    provider,
    cwd: resolveCwd(),
  });
}

export async function applyTargetRepoProvisioningRemote(
  apply: TargetRepoProvisioningApplyInput,
): Promise<TargetRepoProvisioningApplyResult> {
  const provider = await resolveTargetRepoProvisioningProvider();
  if (!provider) {
    throw new Error("GITHUB_TOKEN is required before creating a product repository.");
  }
  return applyTargetRepoProvisioning({
    apply,
    provider,
    cwd: resolveCwd(),
  });
}

export type {
  SetupGuiViewModel,
  LocalSetupFormPayload,
  LocalSetupPreviewResult,
  RemoteSetupSummary,
  RemoteHarnessSecretPreview,
  RemoteHarnessSecretApplyResult,
  RemoteHarnessSecretManualCopyValues,
  RemoteTargetWorkflowPreview,
  RemoteTargetWorkflowApplyResult,
  FirstRunReadiness,
  LinearSetupPreview,
  LinearSetupApplyResult,
  VercelBridgePreview,
  VercelBridgeApplyResult,
  TargetRepoProvisioningPreview,
  TargetRepoProvisioningApplyResult,
  TargetRepoProvisioningRequest,
  TargetRepoProvisioningApplyInput,
  HarnessRepoProvisioningSummary,
};

