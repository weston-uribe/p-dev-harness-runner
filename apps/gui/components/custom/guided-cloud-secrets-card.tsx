"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RemoteHarnessSecretApplyResult,
  RemoteHarnessSecretManualCopyValues,
  RemoteHarnessSecretPreview,
} from "@harness/setup/remote-actions";
import {
  evaluateHarnessSecretPresence,
  HARNESS_ACTIONS_SECRET_NAMES,
} from "@harness/setup/remote-actions";
import type { RemoteSetupSummary } from "@harness/setup/remote-setup-summary";
import type { SetupGuiViewModel } from "@/lib/setup-server";
import type { ControlPlaneReadinessContext } from "@harness/setup/control-plane-types";
import { computeCloudSecretsConfigStateFingerprint } from "@harness/setup/control-plane-readiness";
import {
  assertStep6AutomaticApplyOutcomeInvariant,
  deriveStep6AutomaticApplyOutcome,
  deriveStep6ContinueEligibility,
  deriveStep6RemoteActionEligibility,
  isCloudSecretsApplyEvidenceCurrent,
  step6PostApplyVerificationReady,
  type CloudSecretsApplyEvidence,
  type FirstRunReadiness,
  type ReadinessBlocker,
} from "@harness/setup/first-run-readiness";
import { deriveStep6AutomaticControlState } from "@harness/setup/step6-automatic-control-state";
import { generateGitHubSecretInstructions } from "@harness/setup/generated-instructions";
import {
  beginStep6RemoteStateRevision,
  createStep6RemoteStateRevisionTracker,
  installStep6RemoteSummaryIfLatest,
  isLatestStep6RemoteStateRevision,
} from "@/lib/step6-remote-state";

import { FORM, SPACING } from "@/lib/constants";
import { GUIDED_SETUP_STEP_COUNT } from "@/lib/guided-setup";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/custom/section-card";
import { RemoteActionConfirmation } from "@/components/custom/remote-action-confirmation";
import { ReviewCloudSecretsDisclosure } from "@/components/custom/review-cloud-secrets-disclosure";
import { SetupApplyResult } from "@/components/custom/setup-apply-result";
import { GuidedOperationPanel, buildGuidedOperationPhases } from "@/components/custom/guided-operation-panel";
import { GuidedStepSuccessPanel } from "@/components/custom/guided-step-success-panel";

type CloudSecretsSetupType = "automatic" | "manual";

interface GuidedCloudSecretsCardProps {
  readiness: FirstRunReadiness;
  setupSummary: SetupGuiViewModel;
  controlPlaneContext?: ControlPlaneReadinessContext;
  cloudSecretsPreviewOpened?: boolean;
  remoteSecretPreviewStale?: boolean;
  cloudSecretsApplyEvidence?: CloudSecretsApplyEvidence;
  initialSummary: RemoteSetupSummary;
  onSummaryUpdated?: (summary: RemoteSetupSummary) => void;
  onUiStateChange?: (state: {
    cloudSecretsPreviewOpened?: boolean;
    remoteSecretPreviewStale?: boolean;
    cloudSecretsApplyEvidence?: CloudSecretsApplyEvidence;
  }) => void;
  onContinue: () => void;
  onStepCompleted?: () => void;
  blockedByUpstream?: boolean;
  onGoToHarnessRepo?: () => void;
  onGoToConnectServices?: () => void;
}

function cloudSecretVerificationMessage(summary: RemoteSetupSummary): string {
  const presence = evaluateHarnessSecretPresence(summary.harnessSecretStatuses);
  if (presence.allPresent) {
    return "All required GitHub Actions secrets are present in the harness repo.";
  }
  const parts: string[] = [];
  if (presence.missing.length > 0) {
    parts.push(`Missing: ${presence.missing.join(", ")}`);
  }
  if (presence.unknown.length > 0) {
    parts.push(`Unknown: ${presence.unknown.join(", ")}`);
  }
  return parts.join(". ");
}

function Step6BlockerPanel({ blocker }: { blocker: ReadinessBlocker }) {
  return (
    <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-4">
      <p className="text-sm font-medium">{blocker.message}</p>
      <p className="text-sm text-muted-foreground">{blocker.action}</p>
    </div>
  );
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  throw new Error("Clipboard is not available in this browser.");
}

export function GuidedCloudSecretsCard({
  readiness,
  setupSummary,
  controlPlaneContext,
  cloudSecretsPreviewOpened = false,
  remoteSecretPreviewStale = false,
  cloudSecretsApplyEvidence,
  initialSummary,
  onSummaryUpdated,
  onUiStateChange,
  onContinue,
  onStepCompleted,
  blockedByUpstream = false,
  onGoToHarnessRepo,
  onGoToConnectServices,
}: GuidedCloudSecretsCardProps) {
  const [summary, setSummary] = useState(initialSummary);
  const [setupType, setSetupType] = useState<CloudSecretsSetupType | null>(() =>
    deriveStep6RemoteActionEligibility(initialSummary).allowed
      ? "automatic"
      : null,
  );
  const [previewStaleCleared, setPreviewStaleCleared] = useState(false);
  const [previewOpened, setPreviewOpened] = useState(cloudSecretsPreviewOpened);
  const [preview, setPreview] = useState<RemoteHarnessSecretPreview | null>(null);
  const [previewGenerated, setPreviewGenerated] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState<
    "preview" | "apply" | "refresh" | "manual-values" | "manual-verify" | "mount-refresh" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyResult, setApplyResult] =
    useState<RemoteHarnessSecretApplyResult | null>(null);
  const [verifiedAutomaticSuccess, setVerifiedAutomaticSuccess] = useState(false);
  const [verifiedManualSuccess, setVerifiedManualSuccess] = useState(false);
  const [manualValuesWarningAccepted, setManualValuesWarningAccepted] =
    useState(false);
  const [manualValues, setManualValues] =
    useState<RemoteHarnessSecretManualCopyValues | null>(null);
  const [manualValuesRevealed, setManualValuesRevealed] = useState(false);
  const [manualValuesError, setManualValuesError] = useState<string | null>(null);
  const [manualVerifyMessage, setManualVerifyMessage] = useState<string | null>(
    null,
  );
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [mountRefreshError, setMountRefreshError] = useState<string | null>(null);
  const [initComplete, setInitComplete] = useState(false);

  const CLOUD_SECRETS_INIT_PHASES = ["Preparing repository configuration"] as const;

  const remoteStateRevisionRef = useRef(createStep6RemoteStateRevisionTracker());
  const hasAutoRefreshedRef = useRef(false);

  const currentConfigStateFingerprint = useMemo(
    () =>
      computeCloudSecretsConfigStateFingerprint({
        setupSummary,
        controlPlaneContext,
      }),
    [setupSummary, controlPlaneContext],
  );

  const installRemoteSummary = useCallback(
    (nextSummary: RemoteSetupSummary, revision: number) => {
      installStep6RemoteSummaryIfLatest({
        tracker: remoteStateRevisionRef.current,
        revision,
        summary: nextSummary,
        install: (installedSummary) => {
          setSummary(installedSummary);
          onSummaryUpdated?.(installedSummary);
        },
      });
    },
    [onSummaryUpdated],
  );

  useEffect(() => {
    const revision = beginStep6RemoteStateRevision(remoteStateRevisionRef.current);
    installRemoteSummary(initialSummary, revision);
  }, [initialSummary, installRemoteSummary]);

  useEffect(() => {
    return () => {
      setManualValues(null);
      setManualValuesRevealed(false);
    };
  }, []);

  const refreshSummary = useCallback(
    async (source: "manual" | "mount" = "manual") => {
      const revision = beginStep6RemoteStateRevision(remoteStateRevisionRef.current);
      setLoading(source === "mount" ? "mount-refresh" : "refresh");
      if (source === "mount") {
        setMountRefreshError(null);
      } else {
        setError(null);
      }
      try {
        const response = await fetch("/api/setup/remote-summary");
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Remote summary refresh failed");
        }
        const nextSummary = data as RemoteSetupSummary;
        if (!isLatestStep6RemoteStateRevision(remoteStateRevisionRef.current, revision)) {
          return null;
        }
        installRemoteSummary(nextSummary, revision);
        return nextSummary;
      } catch (refreshError) {
        if (!isLatestStep6RemoteStateRevision(remoteStateRevisionRef.current, revision)) {
          return null;
        }
        const message =
          refreshError instanceof Error
            ? refreshError.message
            : "Remote summary refresh failed";
        if (source === "mount") {
          setMountRefreshError(message);
        } else {
          setError(message);
        }
        return null;
      } finally {
        if (isLatestStep6RemoteStateRevision(remoteStateRevisionRef.current, revision)) {
          setLoading(null);
          if (source === "mount") {
            setInitComplete(true);
          }
        }
      }
    },
    [installRemoteSummary],
  );

  useEffect(() => {
    if (hasAutoRefreshedRef.current) {
      return;
    }
    hasAutoRefreshedRef.current = true;
    void refreshSummary("mount");
  }, [refreshSummary]);

  const previewIsCurrent = preview !== null && previewGenerated;

  useEffect(() => {
    setPreviewOpened(cloudSecretsPreviewOpened);
  }, [cloudSecretsPreviewOpened]);

  const effectivePreviewOpened = previewOpened || cloudSecretsPreviewOpened;

  useEffect(() => {
    if (!effectivePreviewOpened) {
      return;
    }
    onUiStateChange?.({
      remoteSecretPreviewStale: preview !== null && !previewIsCurrent,
    });
  }, [effectivePreviewOpened, onUiStateChange, preview, previewIsCurrent]);

  const remoteActionEligibility = useMemo(
    () => deriveStep6RemoteActionEligibility(summary),
    [summary],
  );

  const remoteActionsBlocked =
    blockedByUpstream || !remoteActionEligibility.allowed;

  const remoteActionsBlockedReason = blockedByUpstream
    ? "Fix harness repo access in local setup before cloud secrets can be configured."
    : remoteActionEligibility.reason;

  const remoteActionsBlockedAction = blockedByUpstream
    ? "Return to Step 4 and verify your harness repo, then refresh."
    : remoteActionEligibility.action;

  const needsSecretWrite = summary.harnessSecretStatuses.some(
    (entry) => entry.status === "missing",
  );

  const applyLabel = needsSecretWrite
    ? "Create encrypted GitHub Actions secrets"
    : "Update encrypted GitHub Actions secrets";

  const manualInstructions = useMemo(
    () =>
      generateGitHubSecretInstructions({
        harnessRepo: summary.harnessDispatchRepo,
      }).steps,
    [summary.harnessDispatchRepo],
  );

  const clearAutomaticPathState = useCallback(() => {
    setPreview(null);
    setPreviewGenerated(false);
    setPreviewError(null);
    setApplyResult(null);
    setVerifiedAutomaticSuccess(false);
    setConfirmed(false);
    setDisclosureOpen(false);
    setError(null);
  }, []);

  const clearManualPathState = useCallback(() => {
    setManualValues(null);
    setManualValuesRevealed(false);
    setManualValuesError(null);
    setManualVerifyMessage(null);
    setVerifiedManualSuccess(false);
    setCopyFeedback(null);
  }, []);

  const handleSetupTypeChange = useCallback(
    (nextType: CloudSecretsSetupType) => {
      setSetupType(nextType);
      if (nextType === "automatic") {
        clearManualPathState();
      } else {
        clearAutomaticPathState();
      }
    },
    [clearAutomaticPathState, clearManualPathState],
  );

  const clearManualValues = useCallback(() => {
    setManualValues(null);
    setManualValuesRevealed(false);
    setManualValuesError(null);
    setCopyFeedback(null);
  }, []);

  const markVerifiedSuccess = useCallback(
    (
      path: CloudSecretsSetupType,
      nextEvidence?: CloudSecretsApplyEvidence,
    ) => {
      setPreviewStaleCleared(true);
      onUiStateChange?.({ remoteSecretPreviewStale: false });
      if (path === "automatic") {
        setVerifiedAutomaticSuccess(true);
        if (nextEvidence) {
          onUiStateChange?.({
            remoteSecretPreviewStale: false,
            cloudSecretsApplyEvidence: nextEvidence,
          });
        }
      } else {
        setVerifiedManualSuccess(true);
      }
      onStepCompleted?.();
    },
    [onStepCompleted, onUiStateChange],
  );

  const runPreview = useCallback(async (): Promise<RemoteHarnessSecretPreview> => {
    const response = await fetch("/api/setup/preview-harness-secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Preview failed");
    }
    const result = data as RemoteHarnessSecretPreview;
    setPreview(result);
    setPreviewGenerated(true);
    return result;
  }, []);

  const markPreviewOpened = useCallback(() => {
    setPreviewOpened(true);
    onUiStateChange?.({ cloudSecretsPreviewOpened: true });
  }, [onUiStateChange]);

  const handlePreview = useCallback(async () => {
    setLoading("preview");
    setError(null);
    setPreviewError(null);
    setApplyResult(null);
    setVerifiedAutomaticSuccess(false);
    setConfirmed(false);
    markPreviewOpened();
    try {
      await runPreview();
    } catch (nextPreviewError) {
      setPreview(null);
      setPreviewGenerated(false);
      setPreviewError(
        nextPreviewError instanceof Error
          ? nextPreviewError.message
          : "Preview failed",
      );
    } finally {
      setLoading(null);
    }
  }, [markPreviewOpened, runPreview]);

  const handleDisclosureOpenChange = useCallback(
    (open: boolean) => {
      if (remoteActionsBlocked) {
        return;
      }
      setDisclosureOpen(open);
      if (open) {
        markPreviewOpened();
        if (!previewIsCurrent && loading !== "preview") {
          void handlePreview();
        }
      }
    },
    [handlePreview, loading, markPreviewOpened, previewIsCurrent, remoteActionsBlocked],
  );

  const handleApply = async () => {
    if (!confirmed || remoteActionsBlocked || loading === "apply") {
      return;
    }

    const revision = beginStep6RemoteStateRevision(remoteStateRevisionRef.current);
    setLoading("apply");
    setError(null);
    setVerifiedAutomaticSuccess(false);
    try {
      const applyPreview =
        previewIsCurrent && preview ? preview : await runPreview();
      if (applyPreview.validationError) {
        throw new Error(applyPreview.validationError);
      }

      const response = await fetch("/api/setup/apply-harness-secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          fingerprint: applyPreview.fingerprint,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Apply failed");
      }

      if (!isLatestStep6RemoteStateRevision(remoteStateRevisionRef.current, revision)) {
        return;
      }

      const nextSummary = data.summary as RemoteSetupSummary;
      const nextApplyResult = data.apply as RemoteHarnessSecretApplyResult;
      const nextEvidence = data.evidence as CloudSecretsApplyEvidence;
      setApplyResult(nextApplyResult);
      installRemoteSummary(nextSummary, revision);
      setPreview(null);
      setPreviewGenerated(false);
      setConfirmed(false);
      setDisclosureOpen(false);

      if (step6PostApplyVerificationReady(nextSummary)) {
        markVerifiedSuccess("automatic", nextEvidence);
      } else {
        setError(
          `Write request completed, but verification failed: ${cloudSecretVerificationMessage(nextSummary)}. Refresh or retry.`,
        );
      }
    } catch (applyError) {
      if (!isLatestStep6RemoteStateRevision(remoteStateRevisionRef.current, revision)) {
        return;
      }
      setError(
        applyError instanceof Error ? applyError.message : "Apply failed",
      );
    } finally {
      if (isLatestStep6RemoteStateRevision(remoteStateRevisionRef.current, revision)) {
        setLoading(null);
      }
    }
  };

  const handleGenerateManualValues = async () => {
    if (remoteActionsBlocked) {
      return;
    }
    if (!manualValuesWarningAccepted) {
      setManualValuesError(
        "Confirm the sensitivity warning before generating manual copy values.",
      );
      return;
    }

    setLoading("manual-values");
    setManualValuesError(null);
    setCopyFeedback(null);
    try {
      const response = await fetch("/api/setup/manual-harness-secret-values", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmedSensitiveReveal: true }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Manual value generation failed");
      }
      setManualValues(data as RemoteHarnessSecretManualCopyValues);
      setManualValuesRevealed(false);
      if ((data as RemoteHarnessSecretManualCopyValues).missing.length > 0) {
        setManualValuesError(
          `Some values are unavailable locally: ${(data as RemoteHarnessSecretManualCopyValues).missing.join(", ")}`,
        );
      }
    } catch (generateError) {
      clearManualValues();
      setManualValuesError(
        generateError instanceof Error
          ? generateError.message
          : "Manual value generation failed",
      );
    } finally {
      setLoading(null);
    }
  };

  const handleManualVerify = async () => {
    if (remoteActionsBlocked) {
      return;
    }
    setLoading("manual-verify");
    setManualVerifyMessage(null);
    setVerifiedManualSuccess(false);
    try {
      const nextSummary = await refreshSummary("manual");
      if (!nextSummary) {
        return;
      }
      if (step6PostApplyVerificationReady(nextSummary)) {
        markVerifiedSuccess("manual");
        setManualVerifyMessage(cloudSecretVerificationMessage(nextSummary));
        clearManualValues();
      } else {
        setManualVerifyMessage(cloudSecretVerificationMessage(nextSummary));
      }
    } finally {
      setLoading(null);
    }
  };

  const handleCopySecret = async (secretName: string, value?: string) => {
    if (!value) {
      setCopyFeedback(`${secretName} is not available to copy.`);
      return;
    }
    try {
      await copyTextToClipboard(value);
      setCopyFeedback(`Copied ${secretName} to clipboard.`);
    } catch (copyError) {
      setCopyFeedback(
        copyError instanceof Error
          ? copyError.message
          : `Could not copy ${secretName}.`,
      );
    }
  };

  const eligibility = useMemo(
    () =>
      deriveStep6ContinueEligibility({
        summary,
        setupSummary,
        localReadinessComplete: readiness.localReadinessComplete,
        uiState: {
          remoteSecretPreviewStale,
          cloudSecretsApplyEvidence,
          cloudSecretsPreviewOpened: effectivePreviewOpened,
        },
        staleSmokeDiagnostics: readiness.staleSmokeDiagnostics,
        controlPlaneContext,
        previewStaleCleared,
      }),
    [
      summary,
      setupSummary,
      readiness.localReadinessComplete,
      readiness.staleSmokeDiagnostics,
      remoteSecretPreviewStale,
      cloudSecretsApplyEvidence,
      controlPlaneContext,
      previewStaleCleared,
      effectivePreviewOpened,
    ],
  );

  const automaticEvidenceCurrent = isCloudSecretsApplyEvidenceCurrent({
    evidence: cloudSecretsApplyEvidence,
    currentConfigStateFingerprint,
    harnessDispatchRepo: summary.harnessDispatchRepo,
  });

  const automaticOutcome = deriveStep6AutomaticApplyOutcome({
    setupType,
    loading,
    applyError: error,
    applyResult,
    verifiedAutomaticSuccess,
    cloudSecretsApplyEvidence,
    eligibility,
    currentConfigStateFingerprint,
    harnessDispatchRepo: summary.harnessDispatchRepo,
  });

  const automaticControlState = deriveStep6AutomaticControlState({
    setupType,
    confirmed,
    loading,
    remoteActionsBlocked,
    remoteActionsBlockedReason,
    previewValidationError: preview?.validationError,
    automaticOutcomeKind: automaticOutcome.kind,
    cloudSecretsPreviewOpened: effectivePreviewOpened,
    remoteSecretPreviewStale,
  });

  const confirmDisabledReason = automaticControlState.confirmDisabledReason;
  const applyDisabledReason = automaticControlState.applyDisabledReason;
  const automaticApplyDisabled = automaticControlState.applyDisabled;

  const userVerifiedSuccess =
    (setupType === "automatic" &&
      (verifiedAutomaticSuccess || automaticEvidenceCurrent)) ||
    (setupType === "manual" && verifiedManualSuccess);

  const canContinue =
    userVerifiedSuccess &&
    eligibility.canContinue &&
    !readiness.cloudSecretsReviewed &&
    !loading &&
    !remoteActionsBlocked;

  const showInitializationPanel = !initComplete;
  const showRemoteActionsBlocked =
    initComplete && remoteActionsBlocked && !showInitializationPanel;

  if (process.env.NODE_ENV !== "production") {
    assertStep6AutomaticApplyOutcomeInvariant({
      outcome: automaticOutcome,
      verifiedAutomaticSuccess,
      applyResult,
      loading,
      canContinue,
    });
  }

  const manualSuccessEligible =
    verifiedManualSuccess &&
    manualVerifyMessage !== null &&
    eligibility.canContinue;

  const manualSuccessBlocked =
    verifiedManualSuccess &&
    manualVerifyMessage !== null &&
    !eligibility.canContinue;

  const primaryBlocker = eligibility.blockers[0];

  return (
    <SectionCard
      title={`Step 6 of ${GUIDED_SETUP_STEP_COUNT} ${"\u00b7"} Connect cloud secrets`}
      description="Your local setup is ready. Choose automatic GitHub Actions secret setup or manual setup in GitHub, then verify before continuing."
    >
      <div className={SPACING.stackSm}>
        {showInitializationPanel ? (
          <GuidedOperationPanel
            phases={buildGuidedOperationPhases({
              labels: [...CLOUD_SECRETS_INIT_PHASES],
              activeIndex: 0,
            })}
            supportingText={CLOUD_SECRETS_INIT_PHASES[0]}
          />
        ) : null}

        {initComplete && mountRefreshError ? (
          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-4">
            <p className="text-sm font-medium">{mountRefreshError}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void refreshSummary("mount")}
              disabled={loading !== null}
            >
              Retry refresh
            </Button>
          </div>
        ) : null}

        {showRemoteActionsBlocked ? (
          <>
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm font-medium">
                {remoteActionsBlockedReason}
              </p>
              {remoteActionsBlockedAction ? (
                <p className="text-sm text-muted-foreground">
                  {remoteActionsBlockedAction}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {remoteActionEligibility.route === "step4-harness-repo" &&
              onGoToHarnessRepo ? (
                <Button type="button" onClick={onGoToHarnessRepo}>
                  Go to Step 4 harness repo
                </Button>
              ) : null}
              {remoteActionEligibility.route === "connect-services" &&
              onGoToConnectServices ? (
                <Button type="button" onClick={onGoToConnectServices}>
                  Go to Step 1 services
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={() => void refreshSummary("manual")}
                disabled={loading !== null}
              >
                {loading === "refresh" ? "Refreshing…" : "Refresh"}
              </Button>
            </div>
          </>
        ) : initComplete ? (
          <>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Setup type</legend>
              <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="setup-type-automatic"
                    type="radio"
                    name="cloud-secrets-setup-type"
                    checked={setupType === "automatic"}
                    onChange={() => handleSetupTypeChange("automatic")}
                  />
                  <Label htmlFor="setup-type-automatic" className="text-sm">
                    Automatic setup
                  </Label>
                </div>
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="setup-type-manual"
                    type="radio"
                    name="cloud-secrets-setup-type"
                    checked={setupType === "manual"}
                    onChange={() => handleSetupTypeChange("manual")}
                  />
                  <Label htmlFor="setup-type-manual" className="text-sm">
                    Manual setup
                  </Label>
                </div>
              </div>
            </fieldset>

            {setupType === "automatic" ? (
              <div className="rounded-md border border-border bg-muted/10 p-4 space-y-4">
                <div className="space-y-2">
                  <p className="text-sm font-medium">Automatic setup</p>
                  <p className="text-sm text-muted-foreground">
                    Write encrypted GitHub Actions secrets to the harness repo
                    through the GitHub API. Preview is optional; preflight runs
                    before apply when you skip preview.
                  </p>
                </div>

                <ReviewCloudSecretsDisclosure
                  open={disclosureOpen}
                  onOpenChange={handleDisclosureOpenChange}
                  isLoading={loading === "preview"}
                  previewError={previewError ?? undefined}
                  preview={preview ?? undefined}
                  previewIsCurrent={previewIsCurrent}
                />

                {loading !== "apply" && !userVerifiedSuccess ? (
                  <RemoteActionConfirmation
                    scope="remote-secret-write"
                    variant="guided"
                    confirmed={confirmed}
                    disabled={automaticControlState.confirmDisabled}
                    disabledReason={confirmDisabledReason}
                    onConfirmedChange={setConfirmed}
                  />
                ) : null}

                <div className={FORM.actions}>
                  <Button
                    type="button"
                    onClick={() => void handleApply()}
                    disabled={automaticApplyDisabled}
                    variant={
                      automaticOutcome.kind === "success" ? "outline" : "default"
                    }
                  >
                    {loading === "apply" ? "Writing secrets…" : applyLabel}
                  </Button>
                  {automaticOutcome.showRefresh ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void refreshSummary("manual")}
                      disabled={loading !== null}
                    >
                      {loading === "refresh" ? "Refreshing…" : "Refresh"}
                    </Button>
                  ) : null}
                  {automaticOutcome.showRetry ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handlePreview()}
                      disabled={loading !== null}
                    >
                      {loading === "preview" ? "Refreshing preview…" : "Preview again"}
                    </Button>
                  ) : null}
                </div>

                {applyDisabledReason && !remoteActionsBlocked ? (
                  <p className="text-sm text-muted-foreground">
                    {applyDisabledReason}
                  </p>
                ) : null}
              </div>
            ) : null}

            {setupType === "manual" ? (
              <div className="rounded-md border border-border bg-background p-4 space-y-4">
                <div className="space-y-2">
                  <p className="text-sm font-medium">Manual setup</p>
                  <p className="text-sm text-muted-foreground">
                    Create or update the required GitHub Actions secrets yourself
                    in the harness repo, then run verify-only checks here.
                  </p>
                </div>

                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {manualInstructions.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>

                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-3">
                  <p className="text-sm font-medium text-destructive">
                    Sensitive values warning
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Manual copy values are secret. Do not paste them into logs,
                    PRs, issues, screenshots, chat, or saved notes.
                  </p>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="manual-values-warning"
                      checked={manualValuesWarningAccepted}
                      onChange={(event) =>
                        setManualValuesWarningAccepted(event.target.checked)
                      }
                    />
                    <Label
                      htmlFor="manual-values-warning"
                      className="text-sm leading-snug"
                    >
                      I understand these values are sensitive and will handle them
                      carefully.
                    </Label>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleGenerateManualValues()}
                    disabled={
                      loading !== null || !manualValuesWarningAccepted
                    }
                  >
                    {loading === "manual-values"
                      ? "Generating manual copy values…"
                      : "Generate manual copy values"}
                  </Button>
                  {manualValues ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setManualValuesRevealed((current) => !current)
                        }
                      >
                        {manualValuesRevealed ? "Hide values" : "Show values"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={clearManualValues}
                      >
                        Clear values
                      </Button>
                    </>
                  ) : null}
                </div>

                {manualValuesError ? (
                  <p className="text-sm text-destructive">{manualValuesError}</p>
                ) : null}
                {copyFeedback ? (
                  <p className="text-sm text-muted-foreground">{copyFeedback}</p>
                ) : null}

                {manualValues ? (
                  <div className="space-y-3">
                    {HARNESS_ACTIONS_SECRET_NAMES.map((secretName) => {
                      const value = manualValues.values[secretName];
                      return (
                        <div
                          key={secretName}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                        >
                          <div>
                            <p className="text-sm font-medium">{secretName}</p>
                            {manualValuesRevealed && value ? (
                              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                                {value}
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                {value
                                  ? "Value ready to copy."
                                  : "Value unavailable locally."}
                              </p>
                            )}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!value}
                            onClick={() =>
                              void handleCopySecret(secretName, value)
                            }
                          >
                            Copy value
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                <p className="text-sm text-muted-foreground">
                  GitHub does not allow secret values to be read back. Verify-only
                  confirms required secret names exist and the harness repo is
                  reachable; it cannot prove the values match your local config or
                  keys.
                </p>

                <div className={FORM.actions}>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleManualVerify()}
                    disabled={loading !== null}
                  >
                    {loading === "manual-verify"
                      ? "Verifying manual setup…"
                      : "Verify manual setup"}
                  </Button>
                </div>

                {manualVerifyMessage && !verifiedManualSuccess ? (
                  <p className="text-sm text-muted-foreground">
                    {manualVerifyMessage}
                  </p>
                ) : null}
              </div>
            ) : null}

            {automaticOutcome.kind === "apply-failed" ||
            automaticOutcome.kind === "verification-inconclusive" ? (
              <SetupApplyResult
                success={false}
                message={automaticOutcome.message ?? "Automatic apply failed."}
              />
            ) : null}

            {automaticOutcome.kind === "success" ? (
              <SetupApplyResult
                success
                message={automaticOutcome.message ?? "Automatic apply succeeded."}
              />
            ) : null}

            {automaticOutcome.kind === "stale-after-apply" ? (
              <SetupApplyResult
                success={false}
                message={automaticOutcome.message ?? "Config changed after apply."}
              />
            ) : null}

            {automaticOutcome.kind === "success-blocked" &&
            automaticOutcome.primaryBlocker ? (
              <Step6BlockerPanel blocker={automaticOutcome.primaryBlocker} />
            ) : null}

            {manualSuccessEligible ? (
              <SetupApplyResult success message={manualVerifyMessage!} />
            ) : null}

            {manualSuccessBlocked && primaryBlocker ? (
              <Step6BlockerPanel blocker={primaryBlocker} />
            ) : null}

            {canContinue ? (
              <GuidedStepSuccessPanel
                heading="Cloud secrets verified"
                explanation="Required GitHub Actions secrets are present in the harness repo and ready for target workflow install."
                details={[
                  setupType === "automatic"
                    ? "Automatic GitHub Actions secret setup verified."
                    : "Manual GitHub Actions secret setup verified.",
                  cloudSecretVerificationMessage(summary),
                ]}
                continueLabel="Continue to target workflow"
                onContinue={onContinue}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}
