import { DeploymentsSettingsEditor } from "@/components/settings/editors/deployments-settings-editor";
import { RunnerUpgradeSettingsCard } from "@/components/settings/editors/runner-upgrade-settings-card";
import { loadDeploymentsEditorData } from "@/lib/settings/load-settings-editor-data";
import { isRunnerUpgradeUiEnabled } from "@/lib/settings/runner-upgrade-feature-flag";

export const dynamic = "force-dynamic";

export default async function SettingsDeploymentsPage() {
  const { summary, runnerUpgradeStatus, workspaceHealth } =
    await loadDeploymentsEditorData();
  const showRunnerUpgrade = isRunnerUpgradeUiEnabled();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Deployments</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {showRunnerUpgrade
            ? "Review the active Vercel deployment identity and update the managed PDev runner when needed."
            : "Review the active Vercel team, project, and production URL for this workspace."}
        </p>
      </div>
      {showRunnerUpgrade ? (
        <RunnerUpgradeSettingsCard initialStatus={runnerUpgradeStatus} />
      ) : null}
      <DeploymentsSettingsEditor
        initialSummary={summary}
        workspaceHealth={workspaceHealth}
      />
    </div>
  );
}
