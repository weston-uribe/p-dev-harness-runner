import { runnerUpgradeStatusLabel } from "@harness/setup/runner-upgrade-types";
import type { RunnerUpgradeStatusResult } from "@harness/setup/runner-upgrade-types";

/** Local-only SSR skeleton — never blocks on GitHub runner-upgrade analysis. */
export function createRunnerUpgradeCheckingSkeleton(): RunnerUpgradeStatusResult {
  return {
    status: "checking",
    statusLabel: runnerUpgradeStatusLabel("checking"),
    degraded: true,
    retryAvailable: true,
    retryGuidance: "Checking runner version…",
  };
}
