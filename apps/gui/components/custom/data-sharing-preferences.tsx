"use client";

import { useCallback, useState } from "react";
import type { ConsentPreference } from "@harness/observability/types.js";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/custom/section-card";
import { SPACING } from "@/lib/constants";
import {
  isUnifiedDataSharingEnabled,
  type ObservabilityPreferencesSnapshot,
} from "@/lib/observability-preferences";

interface PreferencesResponse extends ObservabilityPreferencesSnapshot {
  hasInstallationId: boolean;
}

async function writePreferences(
  body: Record<string, unknown>,
  nonce: string,
): Promise<PreferencesResponse> {
  const response = await fetch("/api/observability/preferences", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-p-dev-observability-nonce": nonce,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error("Could not save data sharing preferences.");
  }
  return (await response.json()) as PreferencesResponse;
}

export type DataSharingPreferencesMode = "onboarding" | "settings";

interface DataSharingPreferencesProps {
  mode: DataSharingPreferencesMode;
  nonce: string | null;
  initialPreferences: ObservabilityPreferencesSnapshot;
  onOnboardingComplete?: (preferences: ObservabilityPreferencesSnapshot) => void;
}

export function DataSharingPreferences({
  mode,
  nonce,
  initialPreferences,
  onOnboardingComplete,
}: DataSharingPreferencesProps) {
  const [baselineEnabled, setBaselineEnabled] = useState(() =>
    isUnifiedDataSharingEnabled(initialPreferences),
  );
  const [checked, setChecked] = useState(() =>
    isUnifiedDataSharingEnabled(initialPreferences),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const isDirty = checked !== baselineEnabled;

  const persist = useCallback(
    async (nextChecked: boolean) => {
      if (!nonce) {
        setError("Data sharing security token is unavailable.");
        return null;
      }
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        const preference: ConsentPreference = nextChecked ? "enabled" : "disabled";
        const next = await writePreferences(
          {
            analyticsPreference: preference,
            errorReportingPreference: preference,
            disclosureShown: true,
          },
          nonce,
        );
        if (mode === "settings") {
          setSaved(true);
          setBaselineEnabled(nextChecked);
        }
        return next;
      } catch (saveError: unknown) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Could not save data sharing preferences.",
        );
        return null;
      } finally {
        setSaving(false);
      }
    },
    [mode, nonce],
  );

  const handleSubmit = useCallback(async () => {
    const next = await persist(checked);
    if (!next) {
      return;
    }
    if (mode === "onboarding") {
      onOnboardingComplete?.({
        analyticsPreference: next.analyticsPreference,
        errorReportingPreference: next.errorReportingPreference,
        disclosureShown: next.disclosureShown,
      });
    }
  }, [checked, mode, onOnboardingComplete, persist]);

  return (
    <SectionCard
      title="Data sharing"
      description="These preferences are stored locally only."
    >
      <div className={SPACING.stackSm}>
        <label className="flex cursor-pointer items-start gap-2 text-sm disabled:cursor-not-allowed has-[:disabled]:cursor-not-allowed">
          <input
            type="checkbox"
            className="mt-0.5 cursor-pointer disabled:cursor-not-allowed"
            checked={checked}
            disabled={saving}
            onChange={(event) => {
              setChecked(event.target.checked);
              setSaved(false);
            }}
            data-guided-step-focus
          />
          <span>
            Allow anonymous product analytics and error reports to improve
            functionality and performance.
          </span>
        </label>
        {mode === "onboarding" ? (
          <p className="text-sm text-muted-foreground">
            You can change this at any time in Settings.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={saving || !nonce || (mode === "settings" && !isDirty)}
            onClick={() => void handleSubmit()}
          >
            {mode === "onboarding" ? "Continue setup" : "Save changes"}
          </Button>
          {mode === "settings" && saved ? (
            <span className="text-sm text-muted-foreground">Saved.</span>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </SectionCard>
  );
}
