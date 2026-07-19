import { redirect } from "next/navigation";
import { AppShell } from "@/components/custom/app-shell";
import { ConfigurePageContent } from "@/components/custom/configure-page-content";
import {
  loadLinearSetupSummary,
  loadHarnessRepoProvisioningSummaryRemote,
  loadRemoteSetupSummary,
  loadSetupFormDefaults,
  loadSetupSummary,
  loadVercelSetupSummary,
} from "@/lib/setup-server";
import {
  markConfigureServerComplete,
  markConfigureServerStart,
  type ConfigureTimingMark,
} from "@/lib/configure-navigation-timing";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { readObservabilityPreferences } from "@harness/observability/facade.js";
import { P_DEV_OBSERVABILITY_NONCE_ENV } from "@harness/observability/constants.js";
import {
  isInitialSetupComplete,
  migrateExistingCompletedWorkspace,
} from "@harness/setup/initial-setup-lifecycle";
import { readControlPlaneSetupState } from "@harness/setup/control-plane-setup-state";
import { WORKFLOW_ROUTE } from "@harness/setup/packaged-default-route";

export const dynamic = "force-dynamic";

async function loadWithTiming<T>(
  label: ConfigureTimingMark,
  loader: () => Promise<T>,
): Promise<T> {
  markConfigureServerStart(label);
  try {
    return await loader();
  } finally {
    markConfigureServerComplete(label, label);
  }
}

export default async function ConfigurePage() {
  markConfigureServerStart("configure_page_start");
  const workspaceDir = resolveHarnessWorkspaceDir();

  const [
    summary,
    formDefaults,
    remoteSummary,
    linearSummary,
    vercelSummary,
    harnessProvisioningSummary,
    observabilityState,
  ] =
    await Promise.all([
      loadWithTiming("configure_loader_setup_summary", loadSetupSummary),
      loadWithTiming("configure_loader_form_defaults", loadSetupFormDefaults),
      loadWithTiming("configure_loader_remote_summary", loadRemoteSetupSummary),
      loadWithTiming("configure_loader_linear_summary", loadLinearSetupSummary),
      loadWithTiming("configure_loader_vercel_summary", loadVercelSetupSummary),
      loadWithTiming(
        "configure_loader_harness_provisioning",
        loadHarnessRepoProvisioningSummaryRemote,
      ),
      loadWithTiming("configure_loader_observability", () =>
        readObservabilityPreferences(workspaceDir),
      ),
    ]);

  const controlPlane =
    (await migrateExistingCompletedWorkspace({
      cwd: workspaceDir,
      setupSummary: summary,
      remoteSummary,
    })) ?? (await readControlPlaneSetupState(workspaceDir));

  if (isInitialSetupComplete(controlPlane)) {
    redirect(WORKFLOW_ROUTE);
  }

  markConfigureServerComplete("configure_page_ready", "configure_page_start");

  const observabilityNonce =
    process.env[P_DEV_OBSERVABILITY_NONCE_ENV]?.trim() ?? null;

  return (
    <AppShell showProductNavigation={false} enableHomeNavigation={false}>
      <ConfigurePageContent
        summary={summary}
        remoteSummary={remoteSummary}
        linearSummary={linearSummary}
        vercelSummary={vercelSummary}
        harnessProvisioningSummary={harnessProvisioningSummary}
        formDefaults={formDefaults}
        observabilityNonce={observabilityNonce}
        observabilityPreferences={{
          analyticsPreference: observabilityState.analyticsPreference,
          errorReportingPreference: observabilityState.errorReportingPreference,
          disclosureShown: observabilityState.disclosureShown,
        }}
      />
    </AppShell>
  );
}
