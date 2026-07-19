import { DeploymentsSettingsEditor } from "@/components/settings/editors/deployments-settings-editor";
import { RunnerUpgradeSettingsCard } from "@/components/settings/editors/runner-upgrade-settings-card";
import { loadDeploymentsEditorData } from "@/lib/settings/load-settings-editor-data";
import { isRunnerUpgradeUiEnabled } from "@/lib/settings/runner-upgrade-feature-flag";

export const dynamic = "force-dynamic";

export default async function SettingsDeploymentsPage() {
  const { summary, runnerUpgradeStatus } = await loadDeploymentsEditorData();
  const showRunnerUpgrade = isRunnerUpgradeUiEnabled();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Deployments</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {showRunnerUpgrade
            ? "Update the managed PDev runner and configure Vercel deployment bridge settings."
            : "Configure Vercel deployment bridge settings."}
        </p>
      </div>
      {showRunnerUpgrade ? (
        <RunnerUpgradeSettingsCard initialStatus={runnerUpgradeStatus} />
      ) : null}
      <DeploymentsSettingsEditor initialSummary={summary} />
    </div>
  );
}
