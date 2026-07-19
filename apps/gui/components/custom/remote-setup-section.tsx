"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  RemoteHarnessSecretApplyResult,
  RemoteHarnessSecretPreview,
} from "@harness/setup/remote-actions";
import type { RemoteSetupSummary } from "@harness/setup/remote-setup-summary";
import { FORM, SPACING } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/custom/section-card";
import { StatusBadge } from "@/components/custom/status-badge";
import {
  RemoteSecretForm,
  type RemoteSecretFormValues,
} from "@/components/custom/remote-secret-form";
import { RemoteActionPreview } from "@/components/custom/remote-action-preview";
import { RemoteActionConfirmation } from "@/components/custom/remote-action-confirmation";
import { TargetWorkflowPrCard } from "@/components/custom/target-workflow-pr-card";
import { SetupApplyResult } from "@/components/custom/setup-apply-result";

interface RemoteSetupSectionProps {
  initialSummary: RemoteSetupSummary;
  onSummaryUpdated?: (summary: RemoteSetupSummary) => void;
  onUiStateChange?: (state: { remoteSecretPreviewStale: boolean }) => void;
  blockedByUpstream?: boolean;
}

function accessVariant(
  status: RemoteSetupSummary["harnessRepoAccess"],
): "success" | "warning" | "destructive" | "secondary" {
  if (status === "available") return "success";
  if (status === "denied") return "destructive";
  return "secondary";
}

export function RemoteSetupSection({
  initialSummary,
  onSummaryUpdated,
  onUiStateChange,
  blockedByUpstream = false,
}: RemoteSetupSectionProps) {
  const [summary, setSummary] = useState(initialSummary);
  const [secretValues, setSecretValues] = useState<RemoteSecretFormValues>({
    linearApiKey: "",
    cursorApiKey: "",
    harnessGithubToken: "",
  });
  const [preview, setPreview] = useState<RemoteHarnessSecretPreview | null>(
    null,
  );
  const [previewPayload, setPreviewPayload] =
    useState<RemoteSecretFormValues | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState<"preview" | "apply" | "refresh" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] =
    useState<RemoteHarnessSecretApplyResult | null>(null);

  useEffect(() => {
    setSummary(initialSummary);
  }, [initialSummary]);

  const currentPayload = useMemo(
    () => ({
      linearApiKey: secretValues.linearApiKey || undefined,
      cursorApiKey: secretValues.cursorApiKey || undefined,
      harnessGithubToken: secretValues.harnessGithubToken || undefined,
    }),
    [secretValues],
  );

  const previewIsCurrent =
    preview !== null &&
    previewPayload !== null &&
    JSON.stringify(previewPayload) === JSON.stringify(secretValues);

  useEffect(() => {
    onUiStateChange?.({
      remoteSecretPreviewStale: preview !== null && !previewIsCurrent,
    });
  }, [onUiStateChange, preview, previewIsCurrent]);

  const refreshSummary = useCallback(async () => {
    setLoading("refresh");
    try {
      const response = await fetch("/api/setup/remote-summary");
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Remote summary refresh failed");
      }
      setSummary(data as RemoteSetupSummary);
      onSummaryUpdated?.(data as RemoteSetupSummary);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Remote summary refresh failed",
      );
    } finally {
      setLoading(null);
    }
  }, [onSummaryUpdated]);

  const resetSecretApplyState = () => {
    setApplyResult(null);
    setError(null);
  };

  const handleSecretPreview = async () => {
    setLoading("preview");
    resetSecretApplyState();
    setConfirmed(false);
    try {
      const response = await fetch("/api/setup/preview-harness-secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentPayload),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Preview failed");
      }
      setPreview(data as RemoteHarnessSecretPreview);
      setPreviewPayload({ ...secretValues });
    } catch (previewError) {
      setPreview(null);
      setPreviewPayload(null);
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Preview failed",
      );
    } finally {
      setLoading(null);
    }
  };

  const handleSecretApply = async () => {
    if (!preview || !previewIsCurrent || !confirmed) {
      return;
    }

    setLoading("apply");
    resetSecretApplyState();
    try {
      const response = await fetch("/api/setup/apply-harness-secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...currentPayload,
          confirmed: true,
          fingerprint: preview.fingerprint,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Apply failed");
      }
      setApplyResult(data.apply as RemoteHarnessSecretApplyResult);
      setSummary(data.summary as RemoteSetupSummary);
      onSummaryUpdated?.(data.summary as RemoteSetupSummary);
      setSecretValues({
        linearApiKey: "",
        cursorApiKey: "",
        harnessGithubToken: "",
      });
      setPreview(null);
      setPreviewPayload(null);
      setConfirmed(false);
    } catch (applyError) {
      setError(
        applyError instanceof Error ? applyError.message : "Apply failed",
      );
    } finally {
      setLoading(null);
    }
  };

  const secretApplyMessage = applyResult
    ? `Wrote ${applyResult.writtenSecrets.map((entry) => entry.name).join(", ") || "no secrets"}.`
    : null;

  const upstreamBlockedReason = blockedByUpstream
    ? "Fix harness repo access in local setup before remote secrets or workflow checks can continue."
    : undefined;
  const previewDisabledReason =
    upstreamBlockedReason ??
    (!summary.githubTokenConfigured
      ? "Set GITHUB_TOKEN in `.env.local` before previewing remote harness secret writes."
      : loading !== null
        ? "Wait for the current action to finish."
        : undefined);
  const confirmDisabledReason = upstreamBlockedReason
    ? upstreamBlockedReason
    : !previewIsCurrent
      ? "Generate a preview before you can confirm this write."
      : preview?.validationError
        ? "Fix validation errors before confirming this write."
        : undefined;
  const applyDisabledReason =
    confirmDisabledReason ??
    (!confirmed
      ? "Confirm the preview before applying harness repo Actions secrets."
      : undefined);

  return (
    <div className={SPACING.section}>
      <SectionCard
        title="Remote setup"
        description="Preview and apply harness repo Actions secrets and target workflow install PRs. Each action requires its own preview and confirmation."
      >
        <dl className="grid grid-cols-1 gap-3 md:grid-cols-2 text-sm">
          <div>
            <dt className="text-muted-foreground">GITHUB_TOKEN in .env.local</dt>
            <dd>
              <StatusBadge
                label={summary.githubTokenConfigured ? "Configured" : "Missing"}
                variant={summary.githubTokenConfigured ? "success" : "warning"}
              />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Harness dispatch repo</dt>
            <dd className="font-medium break-all">{summary.harnessDispatchRepo}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Dispatch repo source</dt>
            <dd className="font-medium">{summary.harnessDispatchRepoSource}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Harness repo access</dt>
            <dd>
              <StatusBadge
                label={summary.harnessRepoAccess}
                variant={accessVariant(summary.harnessRepoAccess)}
              />
            </dd>
          </div>
        </dl>
      </SectionCard>

      {blockedByUpstream ? (
        <SectionCard
          title="Blocked until repo access is fixed"
          description="Remote setup details stay hidden until the harness dispatch repo is corrected."
        >
          <p className="text-sm text-muted-foreground">
            {upstreamBlockedReason} Use the local setup fix above, then refresh
            this page after applying.
          </p>
          <div className={FORM.actions}>
            <Button type="button" onClick={refreshSummary} disabled={loading !== null}>
              {loading === "refresh" ? "Refreshing…" : "Refresh remote setup"}
            </Button>
          </div>
        </SectionCard>
      ) : (
        <>
          <SectionCard
            title="Harness repo Actions secrets"
            description="Write encrypted secrets to the harness dispatch repo. HARNESS_CONFIG_JSON_B64 is generated server-side."
          >
            <RemoteSecretForm
              values={secretValues}
              secretStatuses={summary.harnessSecretStatuses}
              onChange={(values) => {
                resetSecretApplyState();
                setPreview(null);
                setPreviewPayload(null);
                setConfirmed(false);
                setSecretValues(values);
              }}
            />

            <RemoteActionPreview
              harnessSecretPreview={previewIsCurrent ? preview ?? undefined : undefined}
            />

            <RemoteActionConfirmation
              scope="remote-secret-write"
              confirmed={confirmed}
              disabled={!previewIsCurrent || Boolean(preview?.validationError)}
              disabledReason={confirmDisabledReason}
              onConfirmedChange={setConfirmed}
            />

            <div className={FORM.actions}>
              <Button
                type="button"
                onClick={handleSecretPreview}
                disabled={
                  loading !== null ||
                  !summary.githubTokenConfigured ||
                  Boolean(upstreamBlockedReason)
                }
              >
                {loading === "preview" ? "Generating preview…" : "Preview harness secrets"}
              </Button>
              <Button
                type="button"
                onClick={handleSecretApply}
                disabled={
                  loading !== null ||
                  !previewIsCurrent ||
                  !confirmed ||
                  Boolean(preview?.validationError)
                }
              >
                {loading === "apply" ? "Applying…" : "Apply harness secrets"}
              </Button>
            </div>

            {previewDisabledReason ? (
              <p className="text-sm text-muted-foreground">{previewDisabledReason}</p>
            ) : null}
            {applyDisabledReason ? (
              <p className="text-sm text-muted-foreground">{applyDisabledReason}</p>
            ) : null}

            {error ? <SetupApplyResult success={false} message={error} /> : null}
            {secretApplyMessage ? (
              <SetupApplyResult success message={secretApplyMessage} />
            ) : null}
          </SectionCard>

          <SectionCard
            title="Target workflow install PRs"
            description="One install PR card per configured target repo. Never writes directly to production branches."
          >
            {summary.targetRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Resolve `.harness/config.local.json` to show target workflow cards.
              </p>
            ) : (
              <div className={SPACING.stackSm}>
                {summary.targetRepos.map((repo) => (
                  <TargetWorkflowPrCard
                    key={repo.repoConfigId}
                    repo={repo}
                    onApplied={refreshSummary}
                    blockedByUpstream={blockedByUpstream}
                  />
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
