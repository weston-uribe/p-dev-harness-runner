import { DataSharingPreferences } from "@/components/custom/data-sharing-preferences";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { readObservabilityPreferences } from "@harness/observability/facade.js";
import { P_DEV_OBSERVABILITY_NONCE_ENV } from "@harness/observability/constants.js";

export const dynamic = "force-dynamic";

export default async function DataSharingSettingsPage() {
  const workspaceDir = resolveHarnessWorkspaceDir();
  const state = await readObservabilityPreferences(workspaceDir);
  const observabilityNonce =
    process.env[P_DEV_OBSERVABILITY_NONCE_ENV]?.trim() ?? null;

  return (
    <DataSharingPreferences
      mode="settings"
      nonce={observabilityNonce}
      initialPreferences={{
        analyticsPreference: state.analyticsPreference,
        errorReportingPreference: state.errorReportingPreference,
        disclosureShown: state.disclosureShown,
      }}
    />
  );
}
