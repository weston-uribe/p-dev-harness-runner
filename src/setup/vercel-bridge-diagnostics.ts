import { execSync } from "node:child_process";
import { access } from "node:fs/promises";
import type { VercelSignedProbeEvidence } from "./control-plane-types.js";
import type { VercelBridgePreviewFingerprintInputs } from "./control-plane-types.js";
import { readControlPlaneSetupState } from "./control-plane-setup-state.js";
import {
  createLinearSetupClient,
  listLinearWebhooks,
} from "./linear-setup-client.js";
import { findMatchingLinearWebhook } from "./linear-webhook-secret.js";
import { readExistingEnvFile } from "./env-merge.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import { loadSecretFromEnvLocal } from "./service-verification.js";
import { reconstructPollVerifyPreviewForDiagnostics } from "./vercel-bridge-redeploy-poll.js";
import {
  buildVercelBridgePreviewFingerprintInput,
  diffVercelBridgePreviewFingerprintInputs,
  normalizeVercelBridgePlanInput,
  type VercelEnvWritePlanEntry,
} from "./vercel-setup-plan.js";
import {
  buildWebhookUrl,
  getVercelDeployment,
  isVercelDeploymentReady,
  listVercelProductionDeployments,
  resolveCanonicalProductionTarget,
} from "./vercel-setup-client.js";
import { runSignedWebhookProbe } from "./vercel-webhook-probe.js";
import { redactKnownSecretValues } from "./redact-secrets.js";
import { reconcileVercelControlPlaneFromRemote } from "./vercel-bridge-reconcile.js";

export interface VercelBridgeDiagnosticReport {
  gitSha?: string;
  envLocalExists: boolean;
  secretPresence: {
    LINEAR_API_KEY: boolean;
    GITHUB_TOKEN: boolean;
    VERCEL_TOKEN: boolean;
    LINEAR_WEBHOOK_SECRET: boolean;
  };
  controlPlaneVercel?: {
    projectId: string;
    projectName: string;
    teamId?: string;
    productionUrl: string;
    webhookUrl: string;
    signedProbeVerified?: boolean;
    signedProbe?: Pick<
      VercelSignedProbeEvidence,
      "passed" | "result" | "reason" | "statusCode"
    >;
    deploymentRedeployRequired?: boolean;
    appliedFingerprint?: string;
  };
  pendingRedeployVerification?: {
    actionId: string;
    status: string;
    candidateSecretSource?: string;
    fingerprint: string;
    sourceDeploymentIdPresent: boolean;
    newDeploymentIdPresent: boolean;
    verifyAttempted: boolean;
    blockedMessage?: string;
    blockedNextSteps?: string[];
    writtenEnvKeys?: string[];
    skippedEnvKeys?: string[];
  };
  reconstructedPollVerifyPreview?: {
    reconstructionSucceeded: boolean;
    reconstructedFingerprint?: string;
    expectedPendingFingerprint?: string;
    fingerprintsMatch?: boolean;
    envWritePlan?: Array<Pick<VercelEnvWritePlanEntry, "key" | "action" | "source">>;
    linearWebhookSecretMode?: string;
    githubDispatchSource?: string;
    manualStepsCount: number;
    manualSteps: string[];
    setupBlockedMessage?: string;
  };
  fingerprintComponentDiff?: {
    originalFingerprintInputsAvailable: boolean;
    originalFingerprintInputs?: VercelBridgePreviewFingerprintInputs;
    reconstructedFingerprintInputs?: VercelBridgePreviewFingerprintInputs;
    differingKeys: string[];
    recommendation?: string;
  };
  signedProbeDiagnostic: {
    liveProbeExecuted: boolean;
    webhookUrl?: string;
    persistedProbe?: Pick<
      VercelSignedProbeEvidence,
      "passed" | "result" | "reason" | "statusCode" | "webhookHost" | "webhookPath"
    >;
    liveProbe?: Pick<
      VercelSignedProbeEvidence,
      "passed" | "result" | "reason" | "statusCode" | "webhookHost" | "webhookPath"
    >;
  };
  vercelProductionDeployment?: {
    latestProduction?: {
      id: string;
      url: string;
      readyState?: string;
      state: string;
    };
    pendingNewDeployment?: {
      id: string;
      url: string;
      readyState?: string;
      state: string;
    };
    loadError?: string;
  };
  vercelBridgeReconcile?: {
    status: string;
    message: string;
    candidateCount: number;
    candidates: Array<{
      projectId: string;
      projectName: string;
      teamId?: string;
      hasPDevMarker: boolean;
      requiredEnvPresent: boolean;
    }>;
    readinessBlockers?: string[];
  };
  linearWebhookDiagnostic?: {
    expectedWebhookUrl?: string;
    matchingWebhookExists: boolean;
    webhookId?: string;
    enabled?: boolean;
    resourceTypes?: string[];
    secretReadable: boolean;
    loadError?: string;
  };
  webhookTargetDrift?: {
    storedWebhookUrl?: string;
    latestProductionWebhookUrl?: string;
    canonicalProductionWebhookUrl?: string;
    driftDetected: boolean;
    canonicalSource?: "stable_alias" | "latest_ready_deployment";
    matchingPreviousLinearWebhookFound?: boolean;
    canonicalLinearWebhookExists?: boolean;
    reconciliationRecommended?: boolean;
  };
}

function resolveGitSha(cwd: string): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeManualSteps(steps: string[], knownSecrets: string[]): string[] {
  return steps.map((step) => redactKnownSecretValues(step, knownSecrets));
}

function redactReport(report: VercelBridgeDiagnosticReport): VercelBridgeDiagnosticReport {
  return report;
}

export async function buildVercelBridgeDiagnosticReport(input: {
  cwd?: string;
  liveProbe?: boolean;
}): Promise<VercelBridgeDiagnosticReport> {
  const cwd = input.cwd ?? process.cwd();
  const paths = resolveLocalFilePaths(cwd);
  const envLocalExists = await fileExists(paths.envLocal);
  const existingEnv = envLocalExists ? await readExistingEnvFile(paths) : null;

  const secretPresence = {
    LINEAR_API_KEY: existingEnv?.presence.LINEAR_API_KEY ?? false,
    GITHUB_TOKEN: existingEnv?.presence.GITHUB_TOKEN ?? false,
    VERCEL_TOKEN: existingEnv?.presence.VERCEL_TOKEN ?? false,
    LINEAR_WEBHOOK_SECRET: Boolean(
      existingEnv?.values.LINEAR_WEBHOOK_SECRET?.trim(),
    ),
  };

  const state = await readControlPlaneSetupState(cwd);
  const vercel = state?.vercel;
  const pending = vercel?.redeployVerification;

  const knownSecrets: string[] = [];
  const linearApiKey = await loadSecretFromEnvLocal({ cwd, key: "LINEAR_API_KEY" });
  const githubToken = await loadSecretFromEnvLocal({ cwd, key: "GITHUB_TOKEN" });
  const vercelToken = await loadSecretFromEnvLocal({ cwd, key: "VERCEL_TOKEN" });
  const localWebhookSecret = await loadSecretFromEnvLocal({
    cwd,
    key: "LINEAR_WEBHOOK_SECRET",
  });
  if (linearApiKey) knownSecrets.push(linearApiKey);
  if (githubToken) knownSecrets.push(githubToken);
  if (vercelToken) knownSecrets.push(vercelToken);
  if (localWebhookSecret) knownSecrets.push(localWebhookSecret);

  const report: VercelBridgeDiagnosticReport = {
    gitSha: resolveGitSha(cwd),
    envLocalExists,
    secretPresence,
    signedProbeDiagnostic: {
      liveProbeExecuted: input.liveProbe === true,
      webhookUrl: vercel?.webhookUrl,
      persistedProbe: vercel?.signedProbe
        ? {
            passed: vercel.signedProbe.passed,
            result: vercel.signedProbe.result,
            reason: vercel.signedProbe.reason,
            statusCode: vercel.signedProbe.statusCode,
            webhookHost: vercel.signedProbe.webhookHost,
            webhookPath: vercel.signedProbe.webhookPath,
          }
        : undefined,
    },
  };

  if (vercel) {
    report.controlPlaneVercel = {
      projectId: vercel.projectId,
      projectName: vercel.projectName,
      teamId: vercel.teamId,
      productionUrl: vercel.productionUrl,
      webhookUrl: vercel.webhookUrl,
      signedProbeVerified: vercel.signedProbeVerified,
      signedProbe: vercel.signedProbe
        ? {
            passed: vercel.signedProbe.passed,
            result: vercel.signedProbe.result,
            reason: vercel.signedProbe.reason,
            statusCode: vercel.signedProbe.statusCode,
          }
        : undefined,
      deploymentRedeployRequired: vercel.deploymentRedeployRequired,
      appliedFingerprint: vercel.appliedFingerprint,
    };
  }

  if (pending) {
    report.pendingRedeployVerification = {
      actionId: pending.actionId,
      status: pending.status,
      candidateSecretSource: pending.candidateSecretSource,
      fingerprint: pending.fingerprint,
      sourceDeploymentIdPresent: Boolean(pending.sourceDeploymentId?.trim()),
      newDeploymentIdPresent: Boolean(pending.newDeploymentId?.trim()),
      verifyAttempted: Boolean(pending.verifyAttempted),
      blockedMessage: pending.blockedMessage,
      blockedNextSteps: pending.blockedNextSteps,
      writtenEnvKeys: pending.writtenEnvKeys,
      skippedEnvKeys: pending.skippedEnvKeys,
    };
  }

  if (state && pending) {
    const reconstructed = await reconstructPollVerifyPreviewForDiagnostics({
      cwd,
      state,
      pending,
    });

    if (!reconstructed.ok) {
      report.reconstructedPollVerifyPreview = {
        reconstructionSucceeded: false,
        expectedPendingFingerprint: pending.fingerprint,
        manualStepsCount: 0,
        manualSteps: [],
        setupBlockedMessage: reconstructed.setupBlocked.message,
      };
    } else {
      const { plan, vercelToken, preview, fingerprintMatch } = reconstructed;
      const normalized = normalizeVercelBridgePlanInput(plan);
      const reconstructedInputs = buildVercelBridgePreviewFingerprintInput({
        teamId: pending.teamId ?? vercel?.teamId,
        teamMode: normalized.team?.mode,
        teamSlug: normalized.team?.teamSlug,
        projectId: pending.projectId,
        projectMode: normalized.project?.mode,
        projectName: pending.projectName,
        envWritePlan: preview.envWritePlan,
        willGenerateLinearWebhookSecret:
          normalized.willGenerateLinearWebhookSecret ??
          !normalized.envInput?.LINEAR_WEBHOOK_SECRET?.trim(),
        linearWebhookSecretFromEnv: normalized.envInput?.LINEAR_WEBHOOK_SECRET,
        githubDispatchTokenFromEnv: normalized.envInput?.GITHUB_DISPATCH_TOKEN,
        derivedGithubDispatchToken: normalized.derivedGithubDispatchToken,
        harnessTeamKey: normalized.envInput?.HARNESS_TEAM_KEY,
        derivedHarnessTeamKey: normalized.derivedHarnessTeamKey,
        vercelToken,
      });
      const reconstructedFingerprint = preview.fingerprint;

      report.reconstructedPollVerifyPreview = {
        reconstructionSucceeded: true,
        reconstructedFingerprint,
        expectedPendingFingerprint: pending.fingerprint,
        fingerprintsMatch: fingerprintMatch,
        envWritePlan: preview.envWritePlan.map((entry) => ({
          key: entry.key,
          action: entry.action,
          source: entry.source,
        })),
        linearWebhookSecretMode: preview.linearWebhookSecretMode,
        githubDispatchSource: preview.githubDispatchSource,
        manualStepsCount: preview.manualSteps.length,
        manualSteps: sanitizeManualSteps(preview.manualSteps, knownSecrets),
        setupBlockedMessage: fingerprintMatch
          ? undefined
          : "Persisted Step 3 setup context no longer matches the in-progress redeploy verification.",
      };

      const originalInputs = pending.fingerprintInputs;
      report.fingerprintComponentDiff = {
        originalFingerprintInputsAvailable: Boolean(originalInputs),
        originalFingerprintInputs: originalInputs,
        reconstructedFingerprintInputs: reconstructedInputs,
        differingKeys: originalInputs
          ? diffVercelBridgePreviewFingerprintInputs(
              originalInputs,
              reconstructedInputs,
            )
          : [],
        recommendation: originalInputs
          ? undefined
          : "Original pending fingerprint inputs were not persisted. Re-run Step 3 apply after this diagnostics release so future failures include component-level drift evidence.",
      };
    }
  } else if (vercel) {
    report.fingerprintComponentDiff = {
      originalFingerprintInputsAvailable: false,
      differingKeys: [],
      recommendation:
        "No in-progress redeploy verification found. Apply Step 3 again after failure to capture pending fingerprint inputs.",
    };
  }

  if (vercelToken && vercel?.projectId) {
    try {
      const canonicalTarget = await resolveCanonicalProductionTarget({
        vercelToken,
        projectId: vercel.projectId,
        teamId: vercel.teamId,
        preferredDeploymentId: pending?.newDeploymentId,
      });
      const deployments = await listVercelProductionDeployments(
        vercelToken,
        vercel.projectId,
        vercel.teamId,
        { state: "READY", limit: 5 },
      );
      const latestReady = deployments.find((deployment) =>
        isVercelDeploymentReady(deployment),
      );
      const canonicalProductionWebhookUrl = canonicalTarget?.webhookUrl;
      const storedWebhookUrl = vercel.webhookUrl?.trim() || undefined;

      if (canonicalProductionWebhookUrl || latestReady) {
        const driftDetected = Boolean(
          storedWebhookUrl &&
            canonicalProductionWebhookUrl &&
            storedWebhookUrl !== canonicalProductionWebhookUrl,
        );
        report.webhookTargetDrift = {
          storedWebhookUrl,
          latestProductionWebhookUrl: latestReady
            ? buildWebhookUrl(latestReady.url)
            : undefined,
          canonicalProductionWebhookUrl,
          driftDetected,
          canonicalSource: canonicalTarget?.source,
        };

        if (driftDetected && linearApiKey && canonicalProductionWebhookUrl) {
          try {
            const client = createLinearSetupClient(linearApiKey);
            const webhooks = await listLinearWebhooks(client);
            const previousLinearWebhook = storedWebhookUrl
              ? findMatchingLinearWebhook({
                  webhooks,
                  webhookUrl: storedWebhookUrl,
                  linearTeamId: state?.linear?.teamId,
                })
              : undefined;
            const canonicalLinearWebhook = findMatchingLinearWebhook({
              webhooks,
              webhookUrl: canonicalProductionWebhookUrl,
              linearTeamId: state?.linear?.teamId,
            });
            report.webhookTargetDrift = {
              ...report.webhookTargetDrift,
              matchingPreviousLinearWebhookFound: Boolean(previousLinearWebhook),
              canonicalLinearWebhookExists: Boolean(canonicalLinearWebhook),
              reconciliationRecommended: Boolean(
                previousLinearWebhook && !canonicalLinearWebhook,
              ),
            };
          } catch {
            // Leave drift fields without Linear reconciliation metadata.
          }
        }
      }

      if (latestReady) {
        report.vercelProductionDeployment = {
          latestProduction: {
            id: latestReady.id,
            url: latestReady.url,
            readyState: latestReady.readyState,
            state: latestReady.state,
          },
        };
      } else if (canonicalTarget) {
        report.vercelProductionDeployment = {
          latestProduction: {
            id: canonicalTarget.deploymentId,
            url: canonicalTarget.deploymentUrl,
            readyState: canonicalTarget.readyState,
            state: canonicalTarget.state ?? "READY",
          },
        };
      }

      if (pending?.newDeploymentId) {
        const pendingDeployment = await getVercelDeployment(
          vercelToken,
          pending.newDeploymentId,
          pending.teamId ?? vercel.teamId,
        );
        report.vercelProductionDeployment = {
          ...report.vercelProductionDeployment,
          pendingNewDeployment: {
            id: pendingDeployment.id,
            url: pendingDeployment.url,
            readyState: pendingDeployment.readyState,
            state: pendingDeployment.state,
          },
        };
      }
    } catch (error) {
      report.vercelProductionDeployment = {
        loadError:
          error instanceof Error ? error.message : "Failed to load Vercel deployments.",
      };
    }
  }

  if (linearApiKey && vercel?.webhookUrl) {
    try {
      const client = createLinearSetupClient(linearApiKey);
      const webhooks = await listLinearWebhooks(client);
      const matching = findMatchingLinearWebhook({
        webhooks,
        webhookUrl: vercel.webhookUrl,
        linearTeamId: state?.linear?.teamId,
      });
      report.linearWebhookDiagnostic = {
        expectedWebhookUrl: vercel.webhookUrl,
        matchingWebhookExists: Boolean(matching),
        webhookId: matching?.id,
        enabled: matching?.enabled,
        resourceTypes: matching?.resourceTypes,
        secretReadable: Boolean(matching?.secret?.trim()),
      };
    } catch (error) {
      report.linearWebhookDiagnostic = {
        expectedWebhookUrl: vercel.webhookUrl,
        matchingWebhookExists: false,
        secretReadable: false,
        loadError:
          error instanceof Error
            ? error.message
            : "Failed to load Linear webhook metadata.",
      };
    }
  } else if (vercel?.webhookUrl) {
    report.linearWebhookDiagnostic = {
      expectedWebhookUrl: vercel.webhookUrl,
      matchingWebhookExists: false,
      secretReadable: false,
      loadError: "LINEAR_API_KEY is missing; cannot inspect Linear webhooks.",
    };
  }

  if (input.liveProbe === true && localWebhookSecret) {
    const probeWebhookUrl =
      report.webhookTargetDrift?.canonicalProductionWebhookUrl ??
      vercel?.webhookUrl;
    if (probeWebhookUrl) {
      report.signedProbeDiagnostic.webhookUrl = probeWebhookUrl;
      const liveProbe = await runSignedWebhookProbe({
        webhookUrl: probeWebhookUrl,
        secret: localWebhookSecret,
      });
      report.signedProbeDiagnostic.liveProbe = {
        passed: liveProbe.passed,
        result: liveProbe.result,
        reason: liveProbe.reason,
        statusCode: liveProbe.statusCode,
        webhookHost: liveProbe.webhookHost,
        webhookPath: liveProbe.webhookPath,
      };
    }
  }

  const reconcile = await reconcileVercelControlPlaneFromRemote({
    cwd,
    controlPlane: state,
    dryRun: true,
  });
  report.vercelBridgeReconcile = {
    status: reconcile.status,
    message: reconcile.message,
    candidateCount: reconcile.candidates.length,
    candidates: reconcile.candidates.map((candidate) => ({
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      teamId: candidate.teamId,
      hasPDevMarker: candidate.hasPDevMarker,
      requiredEnvPresent: candidate.requiredEnvPresent,
    })),
    readinessBlockers: reconcile.readinessBlockers,
  };

  // Final guard: never emit raw secret values in JSON output.
  const serialized = JSON.stringify(report);
  for (const secret of knownSecrets) {
    if (secret && serialized.includes(secret)) {
      throw new Error("Diagnostic report leaked a known secret value");
    }
  }

  return redactReport(report);
}
