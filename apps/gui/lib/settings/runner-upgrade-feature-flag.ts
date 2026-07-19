/**
 * PDev runner update card is disabled for 0.4 by default.
 * Set P_DEV_RUNNER_UPGRADE_UI_ENABLED=1 to show it again.
 */
export function isRunnerUpgradeUiEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.P_DEV_RUNNER_UPGRADE_UI_ENABLED === "1";
}
