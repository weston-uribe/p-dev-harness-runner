import path from "node:path";
import { isRunnerUpgradeSyncInProgress } from "../setup/runner-upgrade-pending-state.js";

/**
 * During runner upgrade cloud sync, HARNESS_CONFIG_JSON_B64 and
 * HARNESS_CONFIG_FINGERPRINT may temporarily disagree. Harness runs should
 * not move Linear issues to Blocked for cloud_config_stale in that window.
 *
 * When config paths resolve the workspace root to the `.harness` directory
 * (dirname of `.harness/config.local.json`), also check the parent workspace.
 */
export async function isCloudConfigStaleTemporarilyAllowed(
  cwd?: string,
): Promise<boolean> {
  if (await isRunnerUpgradeSyncInProgress(cwd)) {
    return true;
  }
  if (!cwd) {
    return false;
  }
  const resolved = path.resolve(cwd);
  if (path.basename(resolved) === ".harness") {
    return isRunnerUpgradeSyncInProgress(path.dirname(resolved));
  }
  return false;
}
