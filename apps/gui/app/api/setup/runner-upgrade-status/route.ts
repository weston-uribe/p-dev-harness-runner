import { NextResponse } from "next/server";
import { loadRunnerUpgradeStatusForGui } from "@/lib/setup-server";
import type { RunnerUpgradeStatusStage } from "@harness/setup/runner-upgrade-timeouts";

export const dynamic = "force-dynamic";

const TEST_HANG_STAGES = new Set<string>([
  "local_state_reads",
  "embedded_snapshot_identity",
  "provider_wrapper",
  "timeout_wrapper",
  "context_normalization",
  "marker_parsing",
  "status_conversion",
  "reconciliation_enqueue",
  "mutex_acquisition",
  "response_serialization",
]);

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const debugTimings =
      url.searchParams.get("debugTimings") === "1" ||
      process.env.P_DEV_RUNNER_UPGRADE_STATUS_DEBUG === "1";
    const allowTestHooks =
      process.env.NODE_ENV === "test" ||
      process.env.P_DEV_RUNNER_UPGRADE_STATUS_TEST_HOOKS === "1";
    const hangParam = allowTestHooks
      ? url.searchParams.get("testHangAfterStage")
      : null;
    const testHangAfterStage =
      hangParam && TEST_HANG_STAGES.has(hangParam)
        ? (hangParam as RunnerUpgradeStatusStage)
        : undefined;
    const deadlineParam = allowTestHooks
      ? url.searchParams.get("overallDeadlineMs")
      : null;
    const overallDeadlineMs = deadlineParam
      ? Number(deadlineParam)
      : undefined;

    const status = await loadRunnerUpgradeStatusForGui({
      debugTimings,
      testHangAfterStage,
      overallDeadlineMs:
        typeof overallDeadlineMs === "number" &&
        Number.isFinite(overallDeadlineMs) &&
        overallDeadlineMs > 0
          ? overallDeadlineMs
          : undefined,
    });
    return NextResponse.json(status);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Runner upgrade status check failed";
    return NextResponse.json(
      {
        error: message,
        status: "checking",
        statusLabel: "Checking runner version",
        degraded: true,
        retryAvailable: true,
        retryGuidance:
          "Retry status shortly. GitHub did not respond within the page-status deadline.",
      },
      { status: 200 },
    );
  }
}
