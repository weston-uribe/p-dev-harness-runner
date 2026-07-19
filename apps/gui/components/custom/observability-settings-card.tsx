"use client";

import { DataSharingPreferences } from "@/components/custom/data-sharing-preferences";
import type { ObservabilityPreferencesSnapshot } from "@/lib/observability-preferences";

interface ObservabilitySettingsCardProps {
  nonce: string | null;
  initialPreferences: ObservabilityPreferencesSnapshot;
}

/** @deprecated Use DataSharingPreferences directly. */
export function ObservabilitySettingsCard({
  nonce,
  initialPreferences,
}: ObservabilitySettingsCardProps) {
  return (
    <DataSharingPreferences
      mode="settings"
      nonce={nonce}
      initialPreferences={initialPreferences}
    />
  );
}
