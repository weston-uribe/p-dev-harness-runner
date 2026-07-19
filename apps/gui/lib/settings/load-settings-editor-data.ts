import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { loadHarnessConfig } from "@harness/config/load-config";
import { configToFormInput } from "@harness/setup/config-local-editor";
import { readEnvLocalContentFingerprint } from "@harness/setup/credential-patch";
import { readSettingsConfigFingerprint } from "@harness/setup/settings-config-patch";
import {
  loadLinearWorkspaceEditorState,
  loadSetupFormDefaults,
  loadSetupSummary,
  loadVercelSetupSummary,
} from "@/lib/setup-server";
import { loadDurableServiceConnectionSummaries } from "@/lib/verification-state";
import { createRunnerUpgradeCheckingSkeleton } from "@/lib/settings/runner-upgrade-ssr";

export { loadDurableServiceConnectionSummaries };
export { createRunnerUpgradeCheckingSkeleton } from "@/lib/settings/runner-upgrade-ssr";

export async function loadConnectionsEditorData() {
  const cwd = resolveHarnessWorkspaceDir();
  const [summary, formDefaults, envFingerprint] = await Promise.all([
    loadSetupSummary(),
    loadSetupFormDefaults(),
    readEnvLocalContentFingerprint(cwd),
  ]);
  return {
    presence: summary.envKeyPresence,
    envDefaults: formDefaults.env,
    serviceConnectionSummaries: loadDurableServiceConnectionSummaries(
      summary.envKeyPresence,
    ),
    envContentFingerprint: envFingerprint.fingerprint,
  };
}

export async function loadLinearEditorData() {
  return loadLinearWorkspaceEditorState();
}

export async function loadDeploymentsEditorData() {
  const summary = await loadVercelSetupSummary();
  return {
    summary,
    runnerUpgradeStatus: createRunnerUpgradeCheckingSkeleton(),
  };
}

export async function loadRepositoriesEditorData() {
  const cwd = resolveHarnessWorkspaceDir();
  const [{ config }, fingerprint] = await Promise.all([
    loadHarnessConfig({ baseDir: cwd }),
    readSettingsConfigFingerprint(cwd),
  ]);
  return {
    configForm: configToFormInput(config),
    configFingerprint: fingerprint,
  };
}
