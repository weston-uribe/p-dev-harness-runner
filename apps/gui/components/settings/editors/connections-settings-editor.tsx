"use client";

import { useCallback, useEffect, useState } from "react";
import {
  EnvironmentConfigForm,
  type EnvironmentFormPresence,
  type EnvironmentFormValues,
  type ServiceKey,
  type ServiceVerificationMap,
} from "@/components/custom/environment-config-form";
import { VercelRecoveryPanel } from "@/components/settings/vercel-recovery-panel";
import { readSetupJsonResponse } from "@/lib/setup-json-response";
import type { ServiceConnectionSummaryMap } from "@/lib/setup-server";
import {
  loadDurableServiceConnectionSummaries,
  serviceVerificationFromCredentialHealth,
  serviceVerificationFromSummaries,
  valueFingerprint,
} from "@/lib/verification-state";
import type { SavedCredentialHealthMap } from "@harness/setup/credential-health";
import type { CredentialPatchResult } from "@harness/setup/credential-patch";

const SERVICE_VALUE_KEY: Record<
  ServiceKey,
  keyof Pick<
    EnvironmentFormValues,
    "linearApiKey" | "cursorApiKey" | "githubToken" | "vercelToken"
  >
> = {
  LINEAR_API_KEY: "linearApiKey",
  CURSOR_API_KEY: "cursorApiKey",
  GITHUB_TOKEN: "githubToken",
  VERCEL_TOKEN: "vercelToken",
};

type ConnectionsSettingsEditorProps = {
  initialPresence: EnvironmentFormPresence;
  initialServiceConnectionSummaries: ServiceConnectionSummaryMap;
  envDefaults: {
    harnessConfigPath: string;
    githubDispatchRepository: string;
  };
  repairVercel?: boolean;
  envContentFingerprint: string;
};

export function ConnectionsSettingsEditor({
  initialPresence,
  initialServiceConnectionSummaries,
  envDefaults,
  repairVercel = false,
  envContentFingerprint,
}: ConnectionsSettingsEditorProps) {
  const [presence, setPresence] = useState(initialPresence);
  const [fingerprint, setFingerprint] = useState(envContentFingerprint);
  const [values, setValues] = useState<EnvironmentFormValues>({
    harnessConfigPath: envDefaults.harnessConfigPath,
    githubDispatchRepository: envDefaults.githubDispatchRepository,
    linearApiKey: "",
    cursorApiKey: "",
    githubToken: "",
    vercelToken: "",
  });
  const [verification, setVerification] = useState<ServiceVerificationMap>(() =>
    serviceVerificationFromSummaries(initialServiceConnectionSummaries),
  );
  const [verifyingKey, setVerifyingKey] = useState<ServiceKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vercelSuccessMessage, setVercelSuccessMessage] = useState<string | null>(
    null,
  );
  /** Recovery UI active when durable nonterminal op exists or after Vercel save. */
  const [recoveryActive, setRecoveryActive] = useState(false);

  const refreshSavedHealth = useCallback(async () => {
    const response = await fetch("/api/setup/verify-saved-connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const localRuntime =
        response.status >= 500 || contentType.includes("text/html");
      const runtimeHealth = {
        status: localRuntime ? ("local_runtime_error" as const) : ("unknown" as const),
        message: localRuntime
          ? "Local GUI runtime error while verifying saved connections."
          : "Unable to verify saved connections.",
      };
      const health = {
        LINEAR_API_KEY: runtimeHealth,
        CURSOR_API_KEY: runtimeHealth,
        GITHUB_TOKEN: runtimeHealth,
        VERCEL_TOKEN: runtimeHealth,
      } satisfies SavedCredentialHealthMap;
      setVerification(serviceVerificationFromCredentialHealth(health));
      setError(
        localRuntime
          ? "Local GUI runtime error — connection status does not mean credentials are invalid. Restart with p-dev or npm start."
          : "Unable to verify saved connections.",
      );
      return health;
    }
    const result = await readSetupJsonResponse<{
      health: SavedCredentialHealthMap;
    }>(response, "POST /api/setup/verify-saved-connections");
    setVerification(serviceVerificationFromCredentialHealth(result.health));
    setPresence({
      LINEAR_API_KEY: result.health.LINEAR_API_KEY.status !== "missing",
      CURSOR_API_KEY: result.health.CURSOR_API_KEY.status !== "missing",
      GITHUB_TOKEN: result.health.GITHUB_TOKEN.status !== "missing",
      VERCEL_TOKEN: result.health.VERCEL_TOKEN.status !== "missing",
    });
    return result.health;
  }, []);

  useEffect(() => {
    void refreshSavedHealth().catch(() => undefined);
  }, [refreshSavedHealth]);

  // Resume durable recovery on load (independent of React session).
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(
          "/api/setup/vercel-connection-recovery/status",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as {
          operation?: { stage?: string } | null;
        };
        if (body.operation && body.operation.stage !== "ready") {
          setRecoveryActive(true);
        }
      } catch {
        // Non-blocking.
      }
    })();
  }, []);

  const reconnectCredential = useCallback(
    async (key: ServiceKey) => {
      const token = values[SERVICE_VALUE_KEY[key]].trim();
      if (!token) {
        return;
      }

      setVerifyingKey(key);
      setError(null);
      if (key === "VERCEL_TOKEN") {
        setVercelSuccessMessage(null);
      }

      try {
        const response = await fetch("/api/setup/patch-credential", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key,
            value: token,
            expectedConfigFingerprint: fingerprint,
          }),
        });
        const result = (await response.json()) as CredentialPatchResult & {
          error?: string;
        };

        if (!response.ok || !result.ok) {
          const healthState =
            !result.ok && result.credentialHealth
              ? result.credentialHealth
              : "unauthorized";
          setVerification((current) => ({
            ...current,
            [key]: {
              state:
                healthState === "unauthorized"
                  ? "unauthorized"
                  : healthState === "unknown"
                    ? "unknown"
                    : "failed",
              attemptedValueFingerprint: valueFingerprint(token),
              message:
                (!result.ok && result.message) ||
                result.error ||
                "Credential was not saved.",
            },
          }));
          setError(
            (!result.ok && result.message) ||
              result.error ||
              "Credential was not saved. The previous value was preserved.",
          );
          return;
        }

        setFingerprint(result.envContentFingerprint);
        setValues((current) => ({
          ...current,
          [SERVICE_VALUE_KEY[key]]: "",
        }));
        setPresence((current) => ({ ...current, [key]: true }));
        setVerification((current) => ({
          ...current,
          [key]: {
            state: "connected",
            message: result.verification.message,
            label: result.verification.label,
          },
        }));

        if (key === "VERCEL_TOKEN") {
          setVercelSuccessMessage("Credential updated.");
          // Activate embedded controller only — do not start recovery here.
          setRecoveryActive(true);
        } else {
          await refreshSavedHealth();
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Credential update failed.",
        );
      } finally {
        setVerifyingKey(null);
      }
    },
    [fingerprint, refreshSavedHealth, values],
  );

  const showRecovery = recoveryActive || repairVercel;

  return (
    <div className="space-y-6">
      {repairVercel ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium">
            Your Vercel connection needs attention. Reconnect it and PDev will
            repair the automation bridge.
          </p>
        </div>
      ) : null}

      <EnvironmentConfigForm
        values={values}
        presence={presence}
        variant="guided-services"
        verification={verification}
        verifyingKey={verifyingKey}
        emphasizeKey={repairVercel || recoveryActive ? "VERCEL_TOKEN" : null}
        verifyButtonLabel={(key) =>
          key === "VERCEL_TOKEN" && (repairVercel || recoveryActive)
            ? "Reconnect Vercel"
            : "Verify and save"
        }
        helperTextOverride={
          repairVercel || recoveryActive
            ? {
                VERCEL_TOKEN:
                  "Paste a replacement Vercel token. PDev verifies it before saving, then repairs the automation bridge automatically.",
              }
            : undefined
        }
        expandedContent={
          showRecovery
            ? {
                VERCEL_TOKEN: (
                  <VercelRecoveryPanel
                    active
                    variant="embedded"
                    credentialSuccessMessage={vercelSuccessMessage}
                    onCredentialHealthRefresh={() => void refreshSavedHealth()}
                    onActiveChange={(active) => {
                      if (active) {
                        setRecoveryActive(true);
                      }
                    }}
                  />
                ),
              }
            : undefined
        }
        onChange={setValues}
        onVerifyService={(key) => void reconnectCredential(key)}
        onServiceBlur={() => undefined}
      />

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export function seedConnectionsSummaries(
  presence: EnvironmentFormPresence,
): ServiceConnectionSummaryMap {
  return loadDurableServiceConnectionSummaries(presence);
}
