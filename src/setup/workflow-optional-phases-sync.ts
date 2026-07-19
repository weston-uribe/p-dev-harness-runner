import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { HarnessConfig } from "../config/types.js";
import { harnessConfigSchema } from "../config/schema.js";
import { validateRepoClosure } from "../config/load-config.js";
import { migrateWorkflowConfigSection } from "../config/migrate-workflow-config.js";
import {
  generateHarnessConfigJsonB64,
  readValidatedConfigLocalBytes,
} from "./harness-secret-setup.js";
import { formatHarnessDispatchRepo, resolveHarnessDispatchRepo } from "./harness-dispatch-repo.js";
import { sanitizeGitHubSetupError } from "./github-remote-setup-live.js";
import type { GitHubRemoteSetupProvider } from "./github-remote-provider.js";
import { syncHarnessConfigCloudPair } from "./sync-harness-config-cloud.js";
import { resolveLocalFilePaths } from "./setup-state.js";
import { withWorkflowModelSyncLock } from "./workflow-model-sync-lock.js";
import {
  recordWorkflowModelsSyncEvidence,
  type WorkflowModelsSyncEvidence,
} from "./workflow-models-sync-evidence.js";
import { WorkflowModelSyncError } from "./workflow-model-sync.js";
import { ensureOptionalReviewStatusesForConfiguredTeams } from "./linear-optional-status-provision.js";
import { recordOptionalReviewProvisioningEvidence } from "./optional-review-provisioning-evidence.js";
import { loadSecretFromEnvLocal } from "./service-verification.js";

export interface WorkflowOptionalPhasesSaveRequest {
  planReviewEnabled: boolean;
  planReviewCycleLimit: number;
  codeReviewEnabled: boolean;
  codeReviewCycleLimit: number;
  expectedConfigFingerprint: string;
}

export interface WorkflowOptionalPhasesSaveResult {
  saved: true;
  configFingerprint: string;
  localConfigUpdated: true;
  cloudConfigUpdated: true;
  savedAt: string;
  syncEvidenceWarning?: string;
}

async function writeConfigLocalAtomically(
  cwd: string,
  content: string,
): Promise<void> {
  const paths = resolveLocalFilePaths(cwd);
  await mkdir(paths.harnessDir, { recursive: true });
  const tempPath = `${paths.configLocal}.tmp-${process.pid}-${randomUUID()}`;
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  await writeFile(tempPath, normalized, "utf8");
  await rename(tempPath, paths.configLocal);
}

async function mergeOptionalPhasesIntoConfigBytes(input: {
  priorBytes: Buffer;
  planReviewEnabled: boolean;
  planReviewCycleLimit: number;
  codeReviewEnabled: boolean;
  codeReviewCycleLimit: number;
}): Promise<{ content: string; config: HarnessConfig }> {
  const parsed = JSON.parse(input.priorBytes.toString("utf8")) as Record<string, unknown>;
  const baseConfig = harnessConfigSchema.parse(parsed);
  const workflow = migrateWorkflowConfigSection(baseConfig);
  const nextConfig = harnessConfigSchema.parse({
    ...parsed,
    workflow: {
      ...workflow,
      optionalPhases: {
        ...workflow.optionalPhases,
        planReview: input.planReviewEnabled,
        codeReview: input.codeReviewEnabled,
      },
      cycleLimits: {
        ...workflow.cycleLimits,
        planReview: input.planReviewCycleLimit,
        codeReview: input.codeReviewCycleLimit,
      },
    },
  });
  validateRepoClosure(nextConfig);
  const content = `${JSON.stringify(nextConfig, null, 2)}\n`;
  return { content, config: nextConfig };
}

async function restoreConfigLocalBytes(
  cwd: string,
  priorBytes: Buffer,
): Promise<void> {
  const paths = resolveLocalFilePaths(cwd);
  const tempPath = `${paths.configLocal}.rollback-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, priorBytes);
  await rename(tempPath, paths.configLocal);
  await readValidatedConfigLocalBytes(cwd);
}

async function writeHarnessConfigSecretOnly(input: {
  cwd?: string;
  provider: GitHubRemoteSetupProvider;
  encodedValue: string;
}): Promise<{ harnessRepository: string; confirmed: true }> {
  void input.encodedValue;
  const harnessDispatchRepo = await resolveHarnessDispatchRepo({ cwd: input.cwd });
  if (!harnessDispatchRepo.resolved || !harnessDispatchRepo.repo) {
    throw new WorkflowModelSyncError(
      "workflow_model_remote_write_failed",
      "Harness dispatch repository is not configured.",
    );
  }

  const harnessRepository = formatHarnessDispatchRepo(harnessDispatchRepo);

  try {
    await syncHarnessConfigCloudPair({
      cwd: input.cwd,
      provider: input.provider,
      harnessRepository,
    });
    return { harnessRepository, confirmed: true };
  } catch (error) {
    throw new WorkflowModelSyncError(
      "workflow_model_remote_write_failed",
      error instanceof Error
        ? sanitizeGitHubSetupError(error)
        : "Remote config secret write result is uncertain after retries.",
    );
  }
}

export async function saveWorkflowOptionalPhases(input: {
  cwd: string;
  request: WorkflowOptionalPhasesSaveRequest;
  provider?: GitHubRemoteSetupProvider;
}): Promise<WorkflowOptionalPhasesSaveResult> {
  if (
    !Number.isInteger(input.request.planReviewCycleLimit) ||
    input.request.planReviewCycleLimit < 1
  ) {
    throw new WorkflowModelSyncError(
      "workflow_model_validation_failed",
      "Plan Review cycle limit must be a positive integer.",
    );
  }
  if (
    !Number.isInteger(input.request.codeReviewCycleLimit) ||
    input.request.codeReviewCycleLimit < 1
  ) {
    throw new WorkflowModelSyncError(
      "workflow_model_validation_failed",
      "Code Review cycle limit must be a positive integer.",
    );
  }

  return withWorkflowModelSyncLock(input.cwd, async () => {
    const { bytes: priorBytes, hash: currentFingerprint } =
      await readValidatedConfigLocalBytes(input.cwd);

    if (currentFingerprint !== input.request.expectedConfigFingerprint) {
      throw new WorkflowModelSyncError(
        "workflow_model_fingerprint_mismatch",
        "Configuration changed since the page loaded. Reload and try again.",
      );
    }

    const priorParsed = harnessConfigSchema.parse(
      JSON.parse(priorBytes.toString("utf8")),
    );
    const priorWorkflow = migrateWorkflowConfigSection(priorParsed);
    const enablingReview =
      (input.request.planReviewEnabled &&
        !priorWorkflow.optionalPhases.planReview) ||
      (input.request.codeReviewEnabled &&
        !priorWorkflow.optionalPhases.codeReview);

    // When enabling either review: provision/verify Linear statuses BEFORE any
    // config write. Do not report success for provisioning alone.
    if (enablingReview) {
      const linearApiKey = await loadSecretFromEnvLocal({
        cwd: input.cwd,
        key: "LINEAR_API_KEY",
      });
      if (!linearApiKey) {
        throw new WorkflowModelSyncError(
          "workflow_review_status_preflight_failed",
          "LINEAR_API_KEY is required to provision review statuses before enabling reviews.",
        );
      }
      const provision = await ensureOptionalReviewStatusesForConfiguredTeams({
        linearApiKey,
        config: priorParsed,
      });
      try {
        await recordOptionalReviewProvisioningEvidence(provision, input.cwd);
      } catch {
        // Evidence write is best-effort; activation still fail-closed below.
      }
      if (!provision.allTeamsReady) {
        if (provision.conflict) {
          throw new WorkflowModelSyncError(
            "workflow_review_status_conflict",
            provision.message,
          );
        }
        throw new WorkflowModelSyncError(
          "workflow_review_status_setup_required",
          provision.message,
        );
      }
    }

    const { content: nextContent } = await mergeOptionalPhasesIntoConfigBytes({
      priorBytes,
      planReviewEnabled: input.request.planReviewEnabled,
      planReviewCycleLimit: input.request.planReviewCycleLimit,
      codeReviewEnabled: input.request.codeReviewEnabled,
      codeReviewCycleLimit: input.request.codeReviewCycleLimit,
    });

    await writeConfigLocalAtomically(input.cwd, nextContent);
    const { bytes: updatedBytes, hash: updatedFingerprint } =
      await readValidatedConfigLocalBytes(input.cwd);

    if (!input.provider) {
      await restoreConfigLocalBytes(input.cwd, priorBytes);
      throw new WorkflowModelSyncError(
        "workflow_model_remote_write_failed",
        "GitHub credentials are required to synchronize workflow settings.",
      );
    }

    const encodedValue = generateHarnessConfigJsonB64(updatedBytes);

    try {
      const remote = await writeHarnessConfigSecretOnly({
        cwd: input.cwd,
        provider: input.provider,
        encodedValue,
      });

      const savedAt = new Date().toISOString();
      const evidence: WorkflowModelsSyncEvidence = {
        configFingerprint: updatedFingerprint,
        harnessRepository: remote.harnessRepository,
        syncedAt: savedAt,
      };

      let syncEvidenceWarning: string | undefined;
      try {
        await recordWorkflowModelsSyncEvidence(evidence, input.cwd);
      } catch {
        syncEvidenceWarning =
          "Workflow settings were synchronized, but local sync evidence could not be recorded. Run harness:doctor to verify.";
      }

      return {
        saved: true,
        configFingerprint: updatedFingerprint,
        localConfigUpdated: true,
        cloudConfigUpdated: true,
        savedAt,
        ...(syncEvidenceWarning ? { syncEvidenceWarning } : {}),
      };
    } catch (error) {
      if (error instanceof WorkflowModelSyncError) {
        try {
          await restoreConfigLocalBytes(input.cwd, priorBytes);
        } catch {
          throw new WorkflowModelSyncError(
            "workflow_model_sync_partial_failure",
            "Cloud synchronization failed and local configuration could not be restored automatically. Newly created Linear review statuses were left installed; effective activation remains false.",
          );
        }
      }
      throw error;
    }
  });
}
