import path from "node:path";
import { loadHarnessDotenv } from "../../config/load-dotenv.js";
import { EXIT_CONFIG, EXIT_RUN_FAILURE, EXIT_SUCCESS } from "../exit-codes.js";
import {
  hasGithubTokenConfigured,
  loadGithubTokenFromEnvLocal,
} from "../../setup/setup-github-auth.js";
import { createLiveRunnerUpgradeProvider } from "../../setup/runner-upgrade-provider-live.js";
import { tryCreateHarnessTestRunnerUpgradeProvider } from "../../setup/test-only-runner-upgrade-provider.js";
import {
  RELEASE_SYNC_CANARY_POLL_INTERVAL_MS,
  RELEASE_SYNC_CANARY_POLL_TIMEOUT_MS,
  RELEASE_SYNC_OVERALL_TIMEOUT_MS,
  ReleaseSyncManagedRunnerError,
  runReleaseSyncManagedRunner,
} from "../../setup/release-sync-managed-runner.js";
import { RUNNER_UPGRADE_WORKER_PROVIDER_TIMEOUT_MS } from "../../setup/runner-upgrade-timeouts.js";
import { resolveWorkspaceDir } from "../../p-dev/workspace.js";

export async function runSyncManagedRunnerCommand(options: {
  pDevHome?: string;
  apply?: boolean;
  cancelPending?: boolean;
  json?: boolean;
}): Promise<number> {
  const resolved = resolveWorkspaceDir({
    cliWorkspace: options.pDevHome,
    envWorkspace: process.env.P_DEV_HOME,
  });
  const cwd = path.resolve(resolved.workspaceDir);
  process.env.P_DEV_HOME = cwd;
  loadHarnessDotenv(cwd);

  const testProvider = await tryCreateHarnessTestRunnerUpgradeProvider();
  let provider = testProvider;
  if (!provider) {
    const token = await loadGithubTokenFromEnvLocal({ cwd });
    if (!hasGithubTokenConfigured(token)) {
      console.error(
        "release:sync-managed-runner failed: GITHUB_TOKEN is required in the target P_DEV_HOME .env.local",
      );
      return EXIT_CONFIG;
    }
    provider = createLiveRunnerUpgradeProvider(token!, {
      timeoutMs: RUNNER_UPGRADE_WORKER_PROVIDER_TIMEOUT_MS,
    });
  }

  try {
    const executionSlug =
      process.env.P_DEV_EXECUTION_REPOSITORY?.trim() ||
      process.env.GITHUB_DISPATCH_REPOSITORY?.trim() ||
      undefined;
    let expectedRepositoryId: number | undefined;
    if (executionSlug && executionSlug.includes("/")) {
      const [owner, repo] = executionSlug.split("/");
      if (owner && repo) {
        try {
          const info = await provider.getRepositoryMetadata(owner, repo);
          if (info && typeof info.id === "number") {
            expectedRepositoryId = info.id;
          }
        } catch {
          // Fall through — release sync will fail closed on marker/id mismatch.
        }
      }
    }

    const result = await runReleaseSyncManagedRunner(provider, {
      cwd,
      apply: options.apply === true,
      cancelPending: options.cancelPending !== false,
      overallTimeoutMs: RELEASE_SYNC_OVERALL_TIMEOUT_MS,
      canaryPollIntervalMs: RELEASE_SYNC_CANARY_POLL_INTERVAL_MS,
      canaryPollTimeoutMs: RELEASE_SYNC_CANARY_POLL_TIMEOUT_MS,
      ...(executionSlug && expectedRepositoryId !== undefined
        ? {
            expectedRepoSlug: executionSlug,
            expectedRepositoryId,
          }
        : {}),
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`p-dev-home: ${cwd}`);
      if (result.cancel?.cancelled) {
        console.log(
          `cancelled pending upgrade (archived: ${result.cancel.archivedDir ?? "n/a"})`,
        );
        const evidence = result.cancel.remoteMutationEvidence;
        console.log(
          `prior remote evidence: branch=${evidence.hadBranchName} pr=${evidence.hadPrUrl} canary=${evidence.hadCanaryRunUrl} codeUpdateComplete=${evidence.codeUpdateComplete}`,
        );
      }
      console.log(`repo: ${result.repoSlug} (id ${result.repositoryId})`);
      console.log(
        `packaged snapshot: ${result.packagedSnapshotContentId.slice(0, 12)}…`,
      );
      if (result.remoteSnapshotContentId) {
        console.log(
          `remote snapshot: ${result.remoteSnapshotContentId.slice(0, 12)}…`,
        );
      }
      console.log(
        `code update: ${
          result.codeUpdateSkippedBecauseAlreadyCurrent
            ? "skipped (already current)"
            : options.apply
              ? "applied"
              : "would apply"
        }`,
      );
      if (result.fingerprint) {
        console.log(`HARNESS_CONFIG_FINGERPRINT: ${result.fingerprint}`);
      }
      if (result.canaryRunUrl) {
        console.log(`canary: ${result.canaryRunUrl}`);
      }
      console.log(`phase: ${result.phase}`);
      console.log(result.message);
    }

    return result.ok ? EXIT_SUCCESS : EXIT_RUN_FAILURE;
  } catch (error) {
    if (error instanceof ReleaseSyncManagedRunnerError) {
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              phase: error.phase,
              message: error.message,
            },
            null,
            2,
          ),
        );
      } else {
        console.error(
          `release:sync-managed-runner failed at phase=${error.phase}: ${error.message}`,
        );
      }
      return EXIT_RUN_FAILURE;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`release:sync-managed-runner failed: ${message}`);
    return EXIT_CONFIG;
  }
}
