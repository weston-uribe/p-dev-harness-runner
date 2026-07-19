import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { HarnessConfig } from "../config/types.js";
import type { RoleModelRole } from "../config/role-models.js";
import { harnessConfigSchema } from "../config/schema.js";
import { validateRepoClosure } from "../config/load-config.js";
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
import type { RoleModelSelection } from "../config/role-models.js";

export type WorkflowModelSyncErrorCode =
  | "workflow_model_fingerprint_mismatch"
  | "workflow_model_catalog_unavailable"
  | "workflow_model_validation_failed"
  | "workflow_model_local_write_failed"
  | "workflow_model_remote_write_failed"
  | "workflow_model_sync_partial_failure"
  | "workflow_model_sync_unknown"
  | "workflow_review_status_conflict"
  | "workflow_review_status_setup_required"
  | "workflow_review_status_preflight_failed";

export class WorkflowModelSyncError extends Error {
  constructor(
    public readonly code: WorkflowModelSyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowModelSyncError";
  }
}

export interface WorkflowModelSaveRequest {
  role: RoleModelRole;
  modelId: string;
  params: Array<{ id: string; value: string }>;
  expectedConfigFingerprint: string;
}

export interface WorkflowModelSaveResult {
  saved: true;
  role: RoleModelRole;
  modelSelection: RoleModelSelection;
  configFingerprint: string;
  localConfigUpdated: true;
  cloudConfigUpdated: true;
  savedAt: string;
  syncEvidenceWarning?: string;
}

function buildRoleModelSelection(input: {
  modelId: string;
  params: Array<{ id: string; value: string }>;
}): RoleModelSelection {
  return input.params.length
    ? { id: input.modelId, params: input.params }
    : { id: input.modelId };
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

async function mergeRoleModelIntoConfigBytes(input: {
  priorBytes: Buffer;
  role: RoleModelRole;
  modelId: string;
  params: Array<{ id: string; value: string }>;
}): Promise<{ content: string; config: HarnessConfig }> {
  const parsed = JSON.parse(input.priorBytes.toString("utf8")) as Record<string, unknown>;
  const roleModels =
    parsed.roleModels && typeof parsed.roleModels === "object"
      ? { ...(parsed.roleModels as Record<string, unknown>) }
      : {};
  roleModels[input.role] = buildRoleModelSelection({
    modelId: input.modelId,
    params: input.params,
  });
  parsed.roleModels = roleModels;

  const config = harnessConfigSchema.parse(parsed);
  validateRepoClosure(config);
  const content = `${JSON.stringify(config, null, 2)}\n`;
  return { content, config };
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

function isDefiniteRemoteRejection(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("404") ||
    message.includes("422") ||
    message.includes("bad credentials") ||
    message.includes("required for remote")
  );
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
      error instanceof Error && isDefiniteRemoteRejection(error)
        ? "workflow_model_remote_write_failed"
        : "workflow_model_sync_unknown",
      error instanceof Error
        ? sanitizeGitHubSetupError(error)
        : "Remote config secret write result is uncertain after retries.",
    );
  }
}

export async function saveWorkflowRoleModel(input: {
  cwd: string;
  request: WorkflowModelSaveRequest;
  provider?: GitHubRemoteSetupProvider;
}): Promise<WorkflowModelSaveResult> {
  return withWorkflowModelSyncLock(input.cwd, async () => {
    const { bytes: priorBytes, hash: currentFingerprint } =
      await readValidatedConfigLocalBytes(input.cwd);

    if (currentFingerprint !== input.request.expectedConfigFingerprint) {
      throw new WorkflowModelSyncError(
        "workflow_model_fingerprint_mismatch",
        "Configuration changed since the page loaded. Reload and try again.",
      );
    }

    const { content: nextContent } = await mergeRoleModelIntoConfigBytes({
      priorBytes,
      role: input.request.role,
      modelId: input.request.modelId,
      params: input.request.params,
    });

    await writeConfigLocalAtomically(input.cwd, nextContent);
    const { bytes: updatedBytes, hash: updatedFingerprint } =
      await readValidatedConfigLocalBytes(input.cwd);

    if (!input.provider) {
      await restoreConfigLocalBytes(input.cwd, priorBytes);
      throw new WorkflowModelSyncError(
        "workflow_model_remote_write_failed",
        "GitHub credentials are required to synchronize workflow model settings.",
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
          "Model settings were synchronized, but local sync evidence could not be recorded. Run harness:doctor to verify.";
      }

      return {
        saved: true,
        role: input.request.role,
        modelSelection: buildRoleModelSelection({
          modelId: input.request.modelId,
          params: input.request.params,
        }),
        configFingerprint: updatedFingerprint,
        localConfigUpdated: true,
        cloudConfigUpdated: true,
        savedAt,
        ...(syncEvidenceWarning ? { syncEvidenceWarning } : {}),
      };
    } catch (error) {
      if (error instanceof WorkflowModelSyncError) {
        if (error.code === "workflow_model_sync_unknown") {
          throw error;
        }
        try {
          await restoreConfigLocalBytes(input.cwd, priorBytes);
        } catch {
          throw new WorkflowModelSyncError(
            "workflow_model_sync_partial_failure",
            "Cloud synchronization failed and local configuration could not be restored automatically.",
          );
        }
      }
      throw error;
    }
  });
}

export async function readCurrentConfigFingerprint(cwd: string): Promise<string> {
  const { hash } = await readValidatedConfigLocalBytes(cwd);
  return hash;
}
