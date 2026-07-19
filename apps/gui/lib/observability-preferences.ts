import type { ConsentPreference } from "@harness/observability/types.js";

export interface ObservabilityPreferencesSnapshot {
  analyticsPreference: ConsentPreference;
  errorReportingPreference: ConsentPreference;
  disclosureShown: boolean;
}

export function isUnifiedDataSharingEnabled(
  preferences: Pick<
    ObservabilityPreferencesSnapshot,
    "analyticsPreference" | "errorReportingPreference"
  >,
): boolean {
  return (
    preferences.analyticsPreference === "enabled" &&
    preferences.errorReportingPreference === "enabled"
  );
}
