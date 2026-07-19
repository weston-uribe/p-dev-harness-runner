import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { loadHarnessConfig } from "@harness/config/load-config";

export async function loadHarnessConfigSummary() {
  const cwd = resolveHarnessWorkspaceDir();
  try {
    const { config } = await loadHarnessConfig({ baseDir: cwd });
    return {
      orchestratorMarker: config.orchestratorMarker,
      logDirectory: config.logDirectory,
      allowedTargetRepos: config.allowedTargetRepos,
    };
  } catch {
    return {
      orchestratorMarker: "Unavailable",
      logDirectory: "Unavailable",
      allowedTargetRepos: [],
    };
  }
}
