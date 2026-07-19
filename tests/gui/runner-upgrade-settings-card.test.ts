import { describe, expect, it } from "vitest";
import { createRunnerUpgradeCheckingSkeleton } from "../../apps/gui/lib/settings/runner-upgrade-ssr.js";
import {
  formatRunnerUpgradeCurrentSnapshotLine,
  runnerUpgradeCanApply,
  runnerUpgradeCanPreview,
  runnerUpgradeRetryStatusVisible,
} from "../../apps/gui/lib/settings/runner-upgrade-ui-gates.js";
import { runnerUpgradeProgressShowsNoProgress } from "../../src/setup/runner-upgrade-timeouts.js";

describe("Deployments runner upgrade GUI contracts", () => {
  it("SSR deployments loader uses checking skeleton without GitHub status", () => {
    const skeleton = createRunnerUpgradeCheckingSkeleton();
    expect(skeleton.status).toBe("checking");
    expect(skeleton.statusLabel).toBe("Checking runner version");
    expect(skeleton.degraded).toBe(true);
  });

  it("checking state exposes Retry and allows Update with local managed evidence", () => {
    const checking = {
      status: "checking" as const,
      statusLabel: "Checking runner version",
      degraded: true,
      retryAvailable: true,
      localManagedRepoEvidence: true,
      currentSnapshotCached: true,
      currentSnapshot: {
        snapshotContentId: "abc1234567890",
        packageVersion: "0.3.1",
        sourceCommit: "cccccccccccccccccccccccccccccccccccccccc",
      },
      currentSnapshotVerifiedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(runnerUpgradeRetryStatusVisible(checking)).toBe(true);
    expect(
      runnerUpgradeCanApply({
        status: checking,
        tokenUnavailable: false,
        lifecycleBusy: false,
      }),
    ).toBe(true);
    expect(
      runnerUpgradeCanPreview({
        status: checking,
        tokenUnavailable: false,
        lifecycleBusy: false,
      }),
    ).toBe(false);
    expect(formatRunnerUpgradeCurrentSnapshotLine(checking)).toContain(
      "last verified",
    );
    expect(formatRunnerUpgradeCurrentSnapshotLine(checking)).toContain(
      "cached until refreshed",
    );
  });

  it("no-progress helper requires dual-stale timestamps", () => {
    const now = Date.now();
    expect(
      runnerUpgradeProgressShowsNoProgress(
        {
          operationId: "op-1",
          phase: "comparing-runner-snapshots",
          uiPhase: "comparing-runner-snapshots",
          uiPhaseLabel: "Comparing runner snapshots",
          phaseStartedAt: new Date(now - 120_000).toISOString(),
          startedAt: new Date(now - 120_000).toISOString(),
          elapsedMs: 120_000,
          recoveryInstruction: "retry",
          updatedAt: new Date(now - 60_000).toISOString(),
          lastSuccessfulProviderCallAt: new Date(now - 5_000).toISOString(),
          workerHeartbeatAt: new Date(now - 5_000).toISOString(),
        },
        now,
      ),
    ).toBe(false);

    expect(
      runnerUpgradeProgressShowsNoProgress(
        {
          operationId: "op-1",
          phase: "comparing-runner-snapshots",
          uiPhase: "comparing-runner-snapshots",
          uiPhaseLabel: "Comparing runner snapshots",
          phaseStartedAt: new Date(now - 120_000).toISOString(),
          startedAt: new Date(now - 120_000).toISOString(),
          elapsedMs: 120_000,
          recoveryInstruction: "retry",
          updatedAt: new Date(now - 60_000).toISOString(),
          lastSuccessfulProviderCallAt: new Date(now - 60_000).toISOString(),
          workerHeartbeatAt: new Date(now - 60_000).toISOString(),
        },
        now,
      ),
    ).toBe(true);
  });
});
