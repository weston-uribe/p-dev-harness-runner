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
import { loadWorkspaceHealthSnapshot } from "@/lib/workspace-health-server";

export { loadDurableServiceConnectionSummaries };
export { createRunnerUpgradeCheckingSkeleton } from "@/lib/settings/runner-upgrade-ssr";

export async function loadConnectionsEditorData() {
  const cwd = resolveHarnessWorkspaceDir();
  const [summary, formDefaults, envFingerprint, workspaceHealth] =
    await Promise.all([
      loadSetupSummary(),
      loadSetupFormDefaults(),
      readEnvLocalContentFingerprint(cwd),
      loadWorkspaceHealthSnapshot(),
    ]);
  return {
    presence: summary.envKeyPresence,
    envDefaults: formDefaults.env,
    serviceConnectionSummaries: loadDurableServiceConnectionSummaries(
      summary.envKeyPresence,
    ),
    envContentFingerprint: envFingerprint.fingerprint,
    workspaceHealth,
  };
}

export async function loadLinearEditorData() {
  const [editor, workspaceHealth] = await Promise.all([
    loadLinearWorkspaceEditorState(),
    loadWorkspaceHealthSnapshot(),
  ]);
  return {
    ...editor,
    workspaceHealth,
  };
}

export async function loadDeploymentsEditorData() {
  const [summary, workspaceHealth] = await Promise.all([
    loadVercelSetupSummary(),
    loadWorkspaceHealthSnapshot(),
  ]);
  return {
    summary,
    runnerUpgradeStatus: createRunnerUpgradeCheckingSkeleton(),
    workspaceHealth,
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
