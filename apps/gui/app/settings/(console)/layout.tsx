import { redirect } from "next/navigation";
import { AppShell } from "@/components/custom/app-shell";
import { SettingsShell } from "@/components/settings/settings-shell";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { migrateExistingCompletedWorkspace } from "@harness/setup/initial-setup-lifecycle";
import { CONFIGURE_ROUTE } from "@harness/setup/packaged-default-route";
import { classifyWorkspaceEntry } from "@harness/setup/workspace-entry";
import {
  loadRemoteSetupSummary,
  loadSetupSummary,
} from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export default async function SettingsConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cwd = resolveHarnessWorkspaceDir();
  const entry = await classifyWorkspaceEntry(cwd);

  // True first-run workspaces still use Initial Harness Configuration.
  // Established workspaces may always enter Settings (including repair routes).
  if (entry.maturity === "new") {
    redirect(CONFIGURE_ROUTE);
  }

  const [setupSummary, remoteSummary] = await Promise.all([
    loadSetupSummary(),
    loadRemoteSetupSummary(),
  ]);

  await migrateExistingCompletedWorkspace({
    cwd,
    setupSummary,
    remoteSummary,
  });

  return (
    <AppShell settingsHref="/settings" isSettingsActive>
      <SettingsShell>{children}</SettingsShell>
    </AppShell>
  );
}
