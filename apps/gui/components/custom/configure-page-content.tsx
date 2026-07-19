import type { LocalConfigFormInput } from "@harness/setup/config-local-editor";
import type { SetupGuiViewModel } from "@/lib/setup-server";
import type { RemoteSetupSummary } from "@/lib/setup-server";
import type {
  HarnessRepoProvisioningSummary,
  ServiceConnectionSummaryMap,
} from "@/lib/setup-server";
import type { LinearSetupSummary } from "@harness/setup/linear-setup-summary";
import type { VercelSetupSummary } from "@harness/setup/vercel-setup-summary";
import type { ObservabilityPreferencesSnapshot } from "@/lib/observability-preferences";
import { ConfigureExperience } from "@/components/custom/configure-experience";

interface ConfigurePageContentProps {
  summary: SetupGuiViewModel;
  remoteSummary: RemoteSetupSummary;
  linearSummary: LinearSetupSummary;
  vercelSummary: VercelSetupSummary;
  harnessProvisioningSummary: HarnessRepoProvisioningSummary;
  observabilityNonce: string | null;
  observabilityPreferences: ObservabilityPreferencesSnapshot;
  formDefaults: {
    env: {
      harnessConfigPath: string;
      githubDispatchRepository: string;
      suggestedHarnessDispatchRepo?: string;
      secretPresence: {
        LINEAR_API_KEY: boolean;
        CURSOR_API_KEY: boolean;
        GITHUB_TOKEN: boolean;
        VERCEL_TOKEN: boolean;
      };
      serviceConnectionSummaries: ServiceConnectionSummaryMap;
    };
    config: LocalConfigFormInput;
  };
}

export function ConfigurePageContent({
  summary,
  remoteSummary,
  linearSummary,
  vercelSummary,
  harnessProvisioningSummary,
  formDefaults,
  observabilityNonce,
  observabilityPreferences,
}: ConfigurePageContentProps) {
  return (
    <ConfigureExperience
      initialSummary={summary}
      initialRemoteSummary={remoteSummary}
      initialLinearSummary={linearSummary}
      initialVercelSummary={vercelSummary}
      initialHarnessProvisioningSummary={harnessProvisioningSummary}
      formDefaults={formDefaults}
      observabilityNonce={observabilityNonce}
      initialObservabilityPreferences={observabilityPreferences}
    />
  );
}
