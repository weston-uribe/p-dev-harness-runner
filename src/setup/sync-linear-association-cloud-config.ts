import {
  HARNESS_CONFIG_FINGERPRINT_VARIABLE,
} from "../config/cloud-config-fingerprint.js";
import {
  buildCanonicalCloudConfigPair,
  syncHarnessConfigCloudPair,
} from "./sync-harness-config-cloud.js";
import type { GitHubRemoteSetupProvider } from "./github-remote-provider.js";
import {
  formatHarnessDispatchRepo,
  resolveHarnessDispatchRepo,
} from "./harness-dispatch-repo.js";
import { recordWorkflowModelsSyncEvidence } from "./workflow-models-sync-evidence.js";
import { sanitizeGitHubSetupError } from "./github-remote-setup-live.js";

export type LinearAssociationCloudSyncResult =
  | {
      status: "synced";
      fingerprint: string;
      harnessRepository: string;
      syncedAt: string;
    }
  | {
      status: "partial_success";
      fingerprint: string;
      harnessRepository?: string;
      error: string;
      retryable: true;
    };

/**
 * After local Linear association apply succeeds, synchronize the managed-runner
 * cloud config pair and verify the remote fingerprint before recording evidence.
 */
export async function syncLinearAssociationCloudConfig(input: {
  cwd?: string;
  provider: GitHubRemoteSetupProvider;
  harnessRepository?: string;
}): Promise<LinearAssociationCloudSyncResult> {
  const { fingerprint } = await buildCanonicalCloudConfigPair(input.cwd);

  let harnessRepository = input.harnessRepository;
  if (!harnessRepository) {
    const resolved = await resolveHarnessDispatchRepo({ cwd: input.cwd });
    if (!resolved.resolved || !resolved.repo) {
      return {
        status: "partial_success",
        fingerprint,
        error:
          "Linear associations were saved locally, but the harness dispatch repository is not configured for cloud config sync.",
        retryable: true,
      };
    }
    harnessRepository = formatHarnessDispatchRepo(resolved);
  }

  try {
    const syncResult = await syncHarnessConfigCloudPair({
      cwd: input.cwd,
      provider: input.provider,
      harnessRepository,
    });

    if (!input.provider.readHarnessVariable) {
      return {
        status: "partial_success",
        fingerprint: syncResult.fingerprint,
        harnessRepository: syncResult.harnessRepository,
        error:
          "Cloud config was written, but the GitHub provider cannot read HARNESS_CONFIG_FINGERPRINT for verification.",
        retryable: true,
      };
    }

    const remote = await input.provider.readHarnessVariable(
      syncResult.harnessRepository,
      HARNESS_CONFIG_FINGERPRINT_VARIABLE,
    );
    const remoteFingerprint = remote?.value?.trim() ?? "";
    if (!remoteFingerprint || remoteFingerprint !== syncResult.fingerprint) {
      return {
        status: "partial_success",
        fingerprint: syncResult.fingerprint,
        harnessRepository: syncResult.harnessRepository,
        error:
          "Cloud config sync wrote values, but the remote HARNESS_CONFIG_FINGERPRINT does not match the local canonical fingerprint.",
        retryable: true,
      };
    }

    const syncedAt = new Date().toISOString();
    await recordWorkflowModelsSyncEvidence(
      {
        configFingerprint: syncResult.fingerprint,
        harnessRepository: syncResult.harnessRepository,
        syncedAt,
      },
      input.cwd,
    );

    return {
      status: "synced",
      fingerprint: syncResult.fingerprint,
      harnessRepository: syncResult.harnessRepository,
      syncedAt,
    };
  } catch (error) {
    return {
      status: "partial_success",
      fingerprint,
      harnessRepository,
      error:
        error instanceof Error
          ? sanitizeGitHubSetupError(error)
          : "Cloud config synchronization failed after Linear associations were saved locally.",
      retryable: true,
    };
  }
}
