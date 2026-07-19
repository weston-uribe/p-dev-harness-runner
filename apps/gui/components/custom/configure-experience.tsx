"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SetupGuiViewModel } from "@/lib/setup-server";
import type { RemoteSetupSummary } from "@/lib/setup-server";
import type {
  HarnessRepoProvisioningSummary,
  ServiceConnectionSummaryMap,
} from "@/lib/setup-server";
import type { LocalConfigFormInput } from "@harness/setup/config-local-editor";
import type { LinearSetupSummary } from "@harness/setup/linear-setup-summary";
import type { VercelSetupSummary } from "@harness/setup/vercel-setup-summary";
import type { ControlPlaneReadinessContext } from "@harness/setup/control-plane-types";
import {
  deriveFirstRunReadiness,
  shouldInvalidateCloudSecretsApplyEvidence,
  type CloudSecretsApplyEvidence,
  type FirstRunReadinessUiState,
  type FirstRunStepId,
} from "@harness/setup/first-run-readiness";
import { computeCloudSecretsConfigStateFingerprint } from "@harness/setup/control-plane-readiness";
import { markConfigureClient } from "@/lib/configure-navigation-timing";

import { LAYOUT, RESPONSIVE, SPACING } from "@/lib/constants";
import {
  clampGuidedDisplayStep,
  defaultGuidedDisplayStep,
  getGuidedTransitionDirection,
  getPreviousGuidedDisplayStep,
  GUIDED_DISPLAY_STEP_AFTER_LOCAL_APPLY,
  GUIDED_DISPLAY_STEP_AFTER_LOCAL_READINESS,
  GUIDED_DISPLAY_STEP_AFTER_WORKFLOW_READY,
  GUIDED_DISPLAY_STEP_AFTER_CONNECT_SERVICES,
  GUIDED_DISPLAY_STEP_AFTER_CLOUD_SECRETS,
  localSetupFilesExist,
  shouldReadinessAdvanceGuidedDisplay,
  shouldShowGuidedBackButton,
  type GuidedDisplayStepId,
  type GuidedLocalSetupStep,
  deriveGuidedProgressStages,
  guidedDisplayStepIndex,
} from "@/lib/guided-setup";
import {
  syncLinearSummaryFromEnvPresence,
  syncRemoteSummaryFromEnvPresence,
  syncVercelSummaryFromEnvPresence,
} from "@harness/setup/sync-downstream-summaries";
import type { RemoteTargetWorkflowApplyResult } from "@harness/setup/remote-actions";
import type { TargetWorkflowFinalizationResult } from "@harness/setup/target-workflow-finalization-types";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { StatusBadge } from "@/components/custom/status-badge";
import { ConfigureWorkflow } from "@/components/custom/configure-workflow";
import { GuidedLinearWorkspaceCard } from "@/components/custom/guided-linear-workspace-card";
import { GuidedVercelBridgeCard } from "@/components/custom/guided-vercel-bridge-card";
import { GuidedLocalReadinessCard } from "@/components/custom/guided-local-readiness-card";
import { GuidedCloudSecretsCard } from "@/components/custom/guided-cloud-secrets-card";
import { GuidedTargetWorkflowCard } from "@/components/custom/guided-target-workflow-card";
import { SectionCard } from "@/components/custom/section-card";
import { postObservabilityAnalyticsEvent } from "@/lib/observability-client";
import { bucketDurationMs } from "@harness/observability/privacy-schema.js";
import { GuidedSetupProgress } from "@/components/custom/guided-setup-progress";
import { GuidedStepTransition } from "@/components/custom/guided-step-transition";
import { DataSharingPreferences } from "@/components/custom/data-sharing-preferences";
import {
  isUnifiedDataSharingEnabled,
  type ObservabilityPreferencesSnapshot,
} from "@/lib/observability-preferences";

interface ConfigureExperienceProps {
  initialSummary: SetupGuiViewModel;
  initialRemoteSummary: RemoteSetupSummary;
  initialLinearSummary: LinearSetupSummary;
  initialVercelSummary: VercelSetupSummary;
  initialHarnessProvisioningSummary: HarnessRepoProvisioningSummary;
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
  observabilityNonce: string | null;
  initialObservabilityPreferences: ObservabilityPreferencesSnapshot;
}

function buildControlPlaneContext(input: {
  linearSummary: LinearSetupSummary;
  vercelSummary: VercelSetupSummary;
  summary: SetupGuiViewModel;
}): ControlPlaneReadinessContext {
  return {
    state: {
      version: 1,
      linear: input.linearSummary.controlPlane?.linear,
      vercel: input.vercelSummary.controlPlane?.vercel,
    },
    linearTeamKeyFromConfig: input.summary.configSummary?.linearTeamKey,
  };
}

export function ConfigureExperience({
  initialSummary,
  initialRemoteSummary,
  initialLinearSummary,
  initialVercelSummary,
  initialHarnessProvisioningSummary,
  formDefaults,
  observabilityNonce,
  initialObservabilityPreferences,
}: ConfigureExperienceProps) {
  const [observabilityPreferences, setObservabilityPreferences] =
    useState(initialObservabilityPreferences);
  const [setupDisclosureComplete, setSetupDisclosureComplete] = useState(
    initialObservabilityPreferences.disclosureShown,
  );
  const [summary, setSummary] = useState(initialSummary);
  const [remoteSummary, setRemoteSummary] = useState(initialRemoteSummary);
  const [linearSummary, setLinearSummary] = useState(initialLinearSummary);
  const [vercelSummary, setVercelSummary] = useState(initialVercelSummary);
  const [harnessProvisioningSummary, setHarnessProvisioningSummary] = useState(
    initialHarnessProvisioningSummary,
  );
  const [uiState, setUiState] = useState<FirstRunReadinessUiState>({});
  const [initialSetupCompletionError, setInitialSetupCompletionError] =
    useState<string | null>(null);

  useEffect(() => {
    markConfigureClient("configure_content_ready");
  }, []);

  const controlPlaneContext = useMemo(
    () =>
      buildControlPlaneContext({
        linearSummary,
        vercelSummary,
        summary,
      }),
    [linearSummary, vercelSummary, summary],
  );

  const [displayedGuidedStep, setDisplayedGuidedStep] =
    useState<GuidedDisplayStepId>(() =>
      defaultGuidedDisplayStep({
        currentStepId: deriveFirstRunReadiness({
          summary: initialSummary,
          remoteSummary: initialRemoteSummary,
          uiState: {},
          staleSmokeDiagnostics: initialRemoteSummary.staleSmokeDiagnostics,
          harnessProvisioningSummary: initialHarnessProvisioningSummary,
          controlPlaneContext: buildControlPlaneContext({
            linearSummary: initialLinearSummary,
            vercelSummary: initialVercelSummary,
            summary: initialSummary,
          }),
        }).currentStepId,
        summary: initialSummary,
      }),
    );
  const [workflowInstallPendingByRepo, setWorkflowInstallPendingByRepo] =
    useState<Record<string, RemoteTargetWorkflowApplyResult>>({});
  const [workflowFinalizationByRepo, setWorkflowFinalizationByRepo] = useState<
    Record<string, TargetWorkflowFinalizationResult>
  >({});
  const [workflowAwaitingMerge, setWorkflowAwaitingMerge] = useState(false);
  const previousReadinessStepRef = useRef<FirstRunStepId | null>(null);
  const pinnedGuidedDisplayStepRef = useRef<GuidedDisplayStepId | null>(null);
  const [awaitingContinueStep, setAwaitingContinueStep] = useState<
    | "connect-services"
    | "linear-workspace"
    | "vercel-bridge"
    | "choose-target-repos"
    | "local-readiness"
    | "cloud-secrets"
    | "target-workflow"
    | null
  >(null);

  const clearPinnedGuidedDisplayStep = useCallback(() => {
    pinnedGuidedDisplayStepRef.current = null;
  }, []);

  type AwaitingContinueStep = NonNullable<typeof awaitingContinueStep>;

  const holdGuidedStepForContinue = useCallback((step: AwaitingContinueStep) => {
    setAwaitingContinueStep(step);
  }, []);
  const stepVisitCountsRef = useRef<Partial<Record<GuidedDisplayStepId, number>>>(
    {},
  );
  const lastRecordedStepViewRef = useRef<GuidedDisplayStepId | null>(null);
  const stepStartedAtRef = useRef<Partial<Record<GuidedDisplayStepId, number>>>(
    {},
  );

  const recordStepViewed = useCallback(
    (stepId: GuidedDisplayStepId) => {
      lastRecordedStepViewRef.current = stepId;
      const visitOrdinal = stepVisitCountsRef.current[stepId] ?? 0;
      stepVisitCountsRef.current[stepId] = visitOrdinal + 1;
      stepStartedAtRef.current[stepId] = Date.now();
      const stepNumber = guidedDisplayStepIndex(stepId) + 1;
      const payload = {
        type: "p_dev_configure_step_viewed" as const,
        stepId,
        stepNumber,
        resumed: false as const,
        revisited: false as const,
      };
      if (observabilityNonce) {
        void postObservabilityAnalyticsEvent(payload, observabilityNonce);
      }
    },
    [observabilityNonce],
  );

  const recordStepCompleted = useCallback(
    (
      stepId: GuidedDisplayStepId,
      outcome:
        | "success"
        | "skipped_already_complete"
        | "user_correctable_blocked"
        | "operational_failure"
        | "unknown" = "success",
    ) => {
      if (!observabilityNonce) {
        return;
      }
      const startedAt = stepStartedAtRef.current[stepId];
      const durationBucket = bucketDurationMs(
        startedAt ? Date.now() - startedAt : -1,
      );
      const stepNumber = guidedDisplayStepIndex(stepId) + 1;
      void postObservabilityAnalyticsEvent(
        {
          type: "p_dev_configure_step_completed",
          stepId,
          stepNumber,
          resumed: false as const,
          revisited: false as const,
          durationBucket,
          completionOutcome: outcome,
        },
        observabilityNonce,
      );
    },
    [observabilityNonce],
  );

  useEffect(() => {
    recordStepViewed(displayedGuidedStep);
  }, [displayedGuidedStep, recordStepViewed]);

  const readiness = useMemo(
    () =>
      deriveFirstRunReadiness({
        summary,
        remoteSummary,
        uiState,
        staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
        harnessProvisioningSummary,
        controlPlaneContext,
      }),
    [summary, remoteSummary, uiState, harnessProvisioningSummary, controlPlaneContext],
  );

  useEffect(() => {
    const nextStepId = readiness.currentStepId;
    const previousStepId = previousReadinessStepRef.current;
    if (previousStepId === null) {
      previousReadinessStepRef.current = nextStepId;
      return;
    }
    if (awaitingContinueStep !== null) {
      previousReadinessStepRef.current = nextStepId;
      return;
    }
    if (shouldReadinessAdvanceGuidedDisplay(previousStepId, nextStepId)) {
      if (pinnedGuidedDisplayStepRef.current === null) {
        setDisplayedGuidedStep(
          defaultGuidedDisplayStep({
            currentStepId: nextStepId,
            summary,
          }),
        );
      }
    }
    previousReadinessStepRef.current = nextStepId;
  }, [awaitingContinueStep, readiness.currentStepId, summary]);

  useEffect(() => {
    if (awaitingContinueStep !== null) {
      return;
    }
    const clamped = clampGuidedDisplayStep({
      target: displayedGuidedStep,
      currentStepId: readiness.currentStepId,
    });
    if (clamped !== displayedGuidedStep) {
      setDisplayedGuidedStep(clamped);
      pinnedGuidedDisplayStepRef.current = clamped;
    }
  }, [awaitingContinueStep, displayedGuidedStep, readiness.currentStepId]);

  useEffect(() => {
    if (awaitingContinueStep !== null) {
      return;
    }
    if (readiness.readyForFirstRun) {
      setDisplayedGuidedStep("ready-for-first-run");
    }
  }, [awaitingContinueStep, readiness.readyForFirstRun]);

  useEffect(() => {
    if (
      displayedGuidedStep === "ready-for-first-run" &&
      !readiness.readyForFirstRun
    ) {
      setDisplayedGuidedStep(
        defaultGuidedDisplayStep({
          currentStepId: readiness.currentStepId,
          summary,
        }),
      );
    }
  }, [
    displayedGuidedStep,
    readiness.readyForFirstRun,
    readiness.currentStepId,
    summary,
  ]);

  const staleTargetRepoNeedsAttention =
    readiness.staleSmokeDiagnostics.staleTargetRepos.length > 0;
  const staleDispatchRepoNeedsAttention = Boolean(
    readiness.staleSmokeDiagnostics.staleHarnessDispatchRepo,
  );

  const initialEnvForWorkflow = useMemo(() => {
    const suggested = formDefaults.env.suggestedHarnessDispatchRepo;
    const shouldResetDispatch =
      readiness.staleSmokeDiagnostics.staleHarnessDispatchRepo && suggested;

    return {
      harnessConfigPath: formDefaults.env.harnessConfigPath,
      githubDispatchRepository: shouldResetDispatch
        ? suggested ?? ""
        : formDefaults.env.githubDispatchRepository || suggested || "",
      savedHarnessDispatchRepository: formDefaults.env.githubDispatchRepository,
      suggestedHarnessDispatchRepo: suggested,
      secretPresence: {
        LINEAR_API_KEY: summary.envKeyPresence.LINEAR_API_KEY,
        CURSOR_API_KEY: summary.envKeyPresence.CURSOR_API_KEY,
        GITHUB_TOKEN: summary.envKeyPresence.GITHUB_TOKEN,
        VERCEL_TOKEN: summary.envKeyPresence.VERCEL_TOKEN,
      },
      serviceConnectionSummaries: formDefaults.env.serviceConnectionSummaries,
    };
  }, [
    formDefaults.env,
    readiness.staleSmokeDiagnostics.staleHarnessDispatchRepo,
    summary.envKeyPresence.CURSOR_API_KEY,
    summary.envKeyPresence.GITHUB_TOKEN,
    summary.envKeyPresence.LINEAR_API_KEY,
    summary.envKeyPresence.VERCEL_TOKEN,
  ]);

  const handleLocalUiStateChange = useCallback(
    (state: { localPreviewStale: boolean }) => {
      setUiState((current) => {
        if (current.localPreviewStale === state.localPreviewStale) {
          return current;
        }
        return {
          ...current,
          localPreviewStale: state.localPreviewStale,
        };
      });
    },
    [],
  );

  const handleRemoteUiStateChange = useCallback(
    (state: {
      cloudSecretsPreviewOpened?: boolean;
      remoteSecretPreviewStale?: boolean;
      cloudSecretsApplyEvidence?: CloudSecretsApplyEvidence;
    }) => {
      setUiState((current) => {
        let next = current;
        if (
          state.cloudSecretsPreviewOpened !== undefined &&
          current.cloudSecretsPreviewOpened !== state.cloudSecretsPreviewOpened
        ) {
          next = {
            ...next,
            cloudSecretsPreviewOpened: state.cloudSecretsPreviewOpened,
          };
        }
        if (
          state.remoteSecretPreviewStale !== undefined &&
          current.remoteSecretPreviewStale !== state.remoteSecretPreviewStale
        ) {
          next = {
            ...next,
            remoteSecretPreviewStale: state.remoteSecretPreviewStale,
          };
        }
        if ("cloudSecretsApplyEvidence" in state) {
          if (
            current.cloudSecretsApplyEvidence === state.cloudSecretsApplyEvidence
          ) {
            return next === current ? current : next;
          }
          next = {
            ...next,
            cloudSecretsApplyEvidence: state.cloudSecretsApplyEvidence,
          };
        }
        return next === current ? current : next;
      });
    },
    [],
  );

  const handleLinearUiStateChange = useCallback(
    (state: { linearPreviewStale: boolean }) => {
      setUiState((current) => {
        if (current.linearPreviewStale === state.linearPreviewStale) {
          return current;
        }
        return {
          ...current,
          linearPreviewStale: state.linearPreviewStale,
        };
      });
    },
    [],
  );

  const handleVercelUiStateChange = useCallback(
    (state: { vercelPreviewStale: boolean }) => {
      setUiState((current) => {
        if (current.vercelPreviewStale === state.vercelPreviewStale) {
          return current;
        }
        return {
          ...current,
          vercelPreviewStale: state.vercelPreviewStale,
        };
      });
    },
    [],
  );

  const handleConnectServicesComplete = useCallback(async () => {
    clearPinnedGuidedDisplayStep();
    setAwaitingContinueStep(null);
    recordStepCompleted("connect-services");
    setDisplayedGuidedStep(GUIDED_DISPLAY_STEP_AFTER_CONNECT_SERVICES);
    try {
      const response = await fetch("/api/setup/linear-summary");
      const data = await response.json();
      if (response.ok) {
        setLinearSummary(data as LinearSetupSummary);
      }
    } catch {
      // Fall back to env presence synced via handleSummaryUpdated after Step 1 save.
    }
  }, [clearPinnedGuidedDisplayStep, recordStepCompleted]);

  const handleHarnessProvisioningSummaryUpdated = useCallback(
    (nextSummary: HarnessRepoProvisioningSummary) => {
      setHarnessProvisioningSummary(nextSummary);
    },
    [],
  );

  const handleLinearWorkspaceContinue = useCallback(() => {
    clearPinnedGuidedDisplayStep();
    setAwaitingContinueStep(null);
    recordStepCompleted("linear-workspace");
    setDisplayedGuidedStep("vercel-bridge");
  }, [clearPinnedGuidedDisplayStep, recordStepCompleted]);

  const handleVercelBridgeContinue = useCallback(() => {
    clearPinnedGuidedDisplayStep();
    setAwaitingContinueStep(null);
    recordStepCompleted("vercel-bridge");
    setDisplayedGuidedStep("choose-target-repos");
  }, [clearPinnedGuidedDisplayStep, recordStepCompleted]);

  const handleLocalReadinessReviewed = useCallback(() => {
    clearPinnedGuidedDisplayStep();
    setAwaitingContinueStep(null);
    recordStepCompleted("local-readiness");
    setUiState((current) => ({
      ...current,
      localReadinessReviewed: true,
    }));
    setDisplayedGuidedStep(GUIDED_DISPLAY_STEP_AFTER_LOCAL_READINESS);
  }, [clearPinnedGuidedDisplayStep, recordStepCompleted]);

  const handleCloudSecretsReviewed = useCallback(() => {
    clearPinnedGuidedDisplayStep();
    setAwaitingContinueStep(null);
    recordStepCompleted("cloud-secrets");
    setUiState((current) => ({
      ...current,
      cloudSecretsReviewed: true,
    }));
    setDisplayedGuidedStep(GUIDED_DISPLAY_STEP_AFTER_CLOUD_SECRETS);
  }, [clearPinnedGuidedDisplayStep, recordStepCompleted]);

  const handleSummaryUpdated = useCallback((nextSummary: SetupGuiViewModel) => {
    setSummary(nextSummary);
    setLinearSummary((current) =>
      syncLinearSummaryFromEnvPresence(current, nextSummary.envKeyPresence),
    );
    setVercelSummary((current) =>
      syncVercelSummaryFromEnvPresence(current, nextSummary.envKeyPresence),
    );
    setRemoteSummary((current) =>
      syncRemoteSummaryFromEnvPresence(current, nextSummary.envKeyPresence),
    );
    setUiState((current) => {
      const nextControlPlaneContext = buildControlPlaneContext({
        linearSummary,
        vercelSummary,
        summary: nextSummary,
      });
      const invalidateEvidence = shouldInvalidateCloudSecretsApplyEvidence({
        evidence: current.cloudSecretsApplyEvidence,
        currentConfigStateFingerprint: computeCloudSecretsConfigStateFingerprint({
          setupSummary: nextSummary,
          controlPlaneContext: nextControlPlaneContext,
        }),
        harnessDispatchRepo: remoteSummary.harnessDispatchRepo,
      });
      return {
        ...current,
        linearPreviewStale: true,
        vercelPreviewStale: true,
        remoteSecretPreviewStale: current.cloudSecretsPreviewOpened
          ? true
          : current.remoteSecretPreviewStale,
        cloudSecretsApplyEvidence: invalidateEvidence
          ? undefined
          : current.cloudSecretsApplyEvidence,
      };
    });
  }, [linearSummary, remoteSummary.harnessDispatchRepo, vercelSummary]);

  const handleGuidedWorkflowSetupComplete = useCallback(() => {
    recordStepCompleted("target-workflow");
    setInitialSetupCompletionError(null);
    void fetch("/api/setup/complete-initial-setup", { method: "POST" })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          completed?: boolean;
          error?: string;
          unmet?: string[];
          reasons?: Array<{ field: string; code: string; message: string }>;
        } | null;

        if (!response.ok) {
          const unmet = payload?.unmet?.length
            ? ` Unmet: ${payload.unmet.join(", ")}.`
            : "";
          const detail =
            payload?.reasons?.map((reason) => reason.message).join(" ") ??
            payload?.error ??
            "Initial setup completion evidence is not satisfied.";
          setInitialSetupCompletionError(`${detail}${unmet}`);
          return;
        }

        if (payload?.completed) {
          window.location.assign("/workflow");
          return;
        }

        setInitialSetupCompletionError(
          payload?.error ??
            "Initial setup completion did not confirm a durable complete marker.",
        );
      })
      .catch(() => {
        setInitialSetupCompletionError(
          "Initial setup completion request failed. Retry after confirming Linear and Vercel setup evidence.",
        );
      });
    if (observabilityNonce) {
      void postObservabilityAnalyticsEvent(
        { type: "p_dev_setup_completed" },
        observabilityNonce,
      );
    }
  }, [observabilityNonce, recordStepCompleted]);

  const handleGuidedLocalApplySuccess = useCallback(() => {
    setUiState((current) => ({
      ...current,
      localReadinessReviewed: false,
      cloudSecretsReviewed: false,
      cloudSecretsApplyEvidence: undefined,
      remoteSecretPreviewStale: current.cloudSecretsPreviewOpened
        ? true
        : false,
      localPreviewStale: false,
    }));
  }, []);

  const handleChooseTargetReposContinue = useCallback(() => {
    clearPinnedGuidedDisplayStep();
    setAwaitingContinueStep(null);
    recordStepCompleted("choose-target-repos");
    setDisplayedGuidedStep(GUIDED_DISPLAY_STEP_AFTER_LOCAL_APPLY);
  }, [clearPinnedGuidedDisplayStep, recordStepCompleted]);

  const handleTargetWorkflowContinue = useCallback(() => {
    clearPinnedGuidedDisplayStep();
    setAwaitingContinueStep(null);
    setWorkflowAwaitingMerge(false);
    setWorkflowInstallPendingByRepo({});
    setWorkflowFinalizationByRepo({});
    setDisplayedGuidedStep(GUIDED_DISPLAY_STEP_AFTER_WORKFLOW_READY);
  }, [clearPinnedGuidedDisplayStep]);

  const handleGuidedLocalStepChange = useCallback((step: GuidedLocalSetupStep) => {
    setDisplayedGuidedStep(step);
  }, []);

  const invalidateDownstreamFromGuidedStep = useCallback(
    (step: GuidedDisplayStepId) => {
      if (
        step === "connect-services" ||
        step === "linear-workspace" ||
        step === "vercel-bridge" ||
        step === "choose-target-repos"
      ) {
        setUiState((current) => ({
          ...current,
          localReadinessReviewed: false,
          cloudSecretsReviewed: false,
          cloudSecretsApplyEvidence: undefined,
          remoteSecretPreviewStale: current.cloudSecretsPreviewOpened
            ? true
            : current.remoteSecretPreviewStale,
          linearPreviewStale: step === "connect-services" || step === "linear-workspace"
            ? true
            : current.linearPreviewStale,
          vercelPreviewStale: step === "connect-services" ||
            step === "linear-workspace" ||
            step === "vercel-bridge"
            ? true
            : current.vercelPreviewStale,
        }));
        return;
      }

      if (step === "local-readiness") {
        setUiState((current) => ({
          ...current,
          cloudSecretsReviewed: false,
          cloudSecretsApplyEvidence: undefined,
          remoteSecretPreviewStale: current.cloudSecretsPreviewOpened
            ? true
            : current.remoteSecretPreviewStale,
        }));
      }
    },
    [],
  );

  const handleGuidedBack = useCallback(() => {
    const previous = getPreviousGuidedDisplayStep(displayedGuidedStep);
    if (!previous) {
      return;
    }
    const nextDisplay = clampGuidedDisplayStep({
      target: previous,
      currentStepId: readiness.currentStepId,
    });
    setDisplayedGuidedStep(nextDisplay);
    pinnedGuidedDisplayStepRef.current = nextDisplay;
    invalidateDownstreamFromGuidedStep(nextDisplay);
  }, [
    displayedGuidedStep,
    invalidateDownstreamFromGuidedStep,
    readiness.currentStepId,
  ]);

  const showGuidedBackButton = shouldShowGuidedBackButton(displayedGuidedStep);

  const guidedProgressStages = useMemo(
    () =>
      deriveGuidedProgressStages({
        displayedStep: displayedGuidedStep,
        readinessCurrentStepId: readiness.currentStepId,
        readinessSteps: readiness.steps,
        readyForFirstRun: readiness.readyForFirstRun,
        summary,
        controlPlaneContext,
      }),
    [
      controlPlaneContext,
      displayedGuidedStep,
      readiness.currentStepId,
      readiness.readyForFirstRun,
      readiness.steps,
      summary,
    ],
  );

  const actionPanelRef = useRef<HTMLDivElement | null>(null);
  const previousDisplayedStepRef = useRef(displayedGuidedStep);
  const guidedTransitionDirection = getGuidedTransitionDirection(
    previousDisplayedStepRef.current,
    displayedGuidedStep,
  );

  useEffect(() => {
    previousDisplayedStepRef.current = displayedGuidedStep;
  }, [displayedGuidedStep]);

  const renderGuidedActionPanel = () => {
    switch (displayedGuidedStep) {
      case "connect-services":
        return (
          <ConfigureWorkflow
            key="guided-connect-services"
            mode="guided"
            guidedStep="connect-services"
            initialEnv={initialEnvForWorkflow}
            initialConfig={formDefaults.config}
            initialHarnessProvisioningSummary={harnessProvisioningSummary}
            onSummaryUpdated={handleSummaryUpdated}
            onHarnessProvisioningSummaryUpdated={
              handleHarnessProvisioningSummaryUpdated
            }
            onConnectServicesComplete={handleConnectServicesComplete}
            onConnectServicesSucceeded={() =>
              holdGuidedStepForContinue("connect-services")
            }
          />
        );
      case "linear-workspace":
        return (
          <GuidedLinearWorkspaceCard
            readiness={readiness}
            initialSummary={linearSummary}
            linearApiKeyConfigured={summary.envKeyPresence.LINEAR_API_KEY}
            availableRepos={formDefaults.config.repos
              .filter((repo) => repo.id.trim() && repo.targetRepo.trim())
              .map((repo) => ({
                id: repo.id.trim(),
                targetRepo: repo.targetRepo.trim(),
              }))}
            onSummaryUpdated={setLinearSummary}
            onUiStateChange={handleLinearUiStateChange}
            onContinue={handleLinearWorkspaceContinue}
            onStepCompleted={() => holdGuidedStepForContinue("linear-workspace")}
          />
        );
      case "vercel-bridge":
        return (
          <GuidedVercelBridgeCard
            readiness={readiness}
            initialSummary={vercelSummary}
            onSummaryUpdated={setVercelSummary}
            onUiStateChange={handleVercelUiStateChange}
            onContinue={handleVercelBridgeContinue}
            onStepCompleted={() => holdGuidedStepForContinue("vercel-bridge")}
          />
        );
      case "choose-target-repos":
        return (
          <ConfigureWorkflow
            key="guided-local-setup"
            mode="guided"
            guidedStep="choose-target-repos"
            initialEnv={initialEnvForWorkflow}
            initialConfig={formDefaults.config}
            initialHarnessProvisioningSummary={harnessProvisioningSummary}
            highlightStaleDispatch={staleDispatchRepoNeedsAttention}
            highlightStaleTarget={staleTargetRepoNeedsAttention}
            onSummaryUpdated={handleSummaryUpdated}
            onHarnessProvisioningSummaryUpdated={
              handleHarnessProvisioningSummaryUpdated
            }
            onUiStateChange={handleLocalUiStateChange}
            onGuidedLocalApplySuccess={handleGuidedLocalApplySuccess}
            onContinue={handleChooseTargetReposContinue}
            onStepCompleted={() =>
              holdGuidedStepForContinue("choose-target-repos")
            }
            localSetupFilesExist={localSetupFilesExist(summary)}
          />
        );
      case "local-readiness":
        return (
          <GuidedLocalReadinessCard
            readiness={readiness}
            onContinue={handleLocalReadinessReviewed}
            onStepCompleted={() => holdGuidedStepForContinue("local-readiness")}
          />
        );
      case "cloud-secrets":
        return (
          <GuidedCloudSecretsCard
            readiness={readiness}
            setupSummary={summary}
            controlPlaneContext={controlPlaneContext}
            cloudSecretsPreviewOpened={uiState.cloudSecretsPreviewOpened}
            remoteSecretPreviewStale={uiState.remoteSecretPreviewStale}
            cloudSecretsApplyEvidence={uiState.cloudSecretsApplyEvidence}
            initialSummary={remoteSummary}
            onSummaryUpdated={setRemoteSummary}
            onUiStateChange={handleRemoteUiStateChange}
            onContinue={handleCloudSecretsReviewed}
            onStepCompleted={() => holdGuidedStepForContinue("cloud-secrets")}
            blockedByUpstream={readiness.remoteSetupBlockedByUpstream}
            onGoToHarnessRepo={() => setDisplayedGuidedStep("choose-target-repos")}
            onGoToConnectServices={() =>
              setDisplayedGuidedStep("connect-services")
            }
          />
        );
      case "target-workflow":
        return (
          <GuidedTargetWorkflowCard
            initialSummary={remoteSummary}
            onSummaryUpdated={setRemoteSummary}
            onWorkflowSetupComplete={handleGuidedWorkflowSetupComplete}
            onWorkflowAwaitingMergeChange={setWorkflowAwaitingMerge}
            pendingInstallByRepo={workflowInstallPendingByRepo}
            finalizationByRepo={workflowFinalizationByRepo}
            onPendingInstallChange={setWorkflowInstallPendingByRepo}
            onFinalizationChange={setWorkflowFinalizationByRepo}
            onStepCompleted={() => holdGuidedStepForContinue("target-workflow")}
            onContinue={handleTargetWorkflowContinue}
            blockedByUpstream={readiness.remoteSetupBlockedByUpstream}
          />
        );
      case "ready-for-first-run":
        return (
          <SectionCard
            title="Setup complete"
            description="Harness setup is ready for workflow configuration and future runs."
          >
            <div className={SPACING.stackSm}>
              <StatusBadge label="Setup complete" variant="success" />
              <p className="text-sm text-muted-foreground">
                Your harness setup is ready. The target workflow install finished
                automatically when production verification succeeded.
              </p>
              <p className="text-sm text-muted-foreground">
                {readiness.prohibitedActionsNote}
              </p>
              <Button asChild>
                <Link href="/workflow">Continue to Workflow</Link>
              </Button>
            </div>
          </SectionCard>
        );
    }
  };

  const guidedStatusBadgeLabel = readiness.readyForFirstRun
    ? "Setup complete"
    : workflowAwaitingMerge
      ? "Finalizing workflow install"
      : "Setup in progress";

  const handleDataSharingOnboardingComplete = useCallback(
    (preferences: ObservabilityPreferencesSnapshot) => {
      setObservabilityPreferences(preferences);
      setSetupDisclosureComplete(true);
      if (isUnifiedDataSharingEnabled(preferences)) {
        lastRecordedStepViewRef.current = null;
        recordStepViewed(displayedGuidedStep);
      }
    },
    [displayedGuidedStep, recordStepViewed],
  );

  if (!setupDisclosureComplete) {
    return (
      <div className={LAYOUT.configureContent}>
        <DataSharingPreferences
          mode="onboarding"
          nonce={observabilityNonce}
          initialPreferences={observabilityPreferences}
          onOnboardingComplete={handleDataSharingOnboardingComplete}
        />
      </div>
    );
  }

  return (
    <div className={`${LAYOUT.configureContent} ${LAYOUT.sectionStack}`}>
      <section className={SPACING.section}>
        <div className={SPACING.stackSm}>
          <h2 className={RESPONSIVE.pageTitle}>Initial Harness Configuration</h2>
          <p className={RESPONSIVE.pageDescription}>
            Guided first-run readiness for the Product Development Harness.
            Complete local setup, local readiness checks, cloud secrets, and
            target workflow install before your first future harness run.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {showGuidedBackButton ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={handleGuidedBack}
              >
                Back
              </Button>
            ) : null}
            <div className={SPACING.inline}>
              <StatusBadge
                label={guidedStatusBadgeLabel}
                variant={readiness.readyForFirstRun ? "success" : "warning"}
              />
            </div>
          </div>
        </div>
      </section>

      <section className={SPACING.section}>
        <GuidedSetupProgress stages={guidedProgressStages} />
      </section>

      {initialSetupCompletionError ? (
        <section className={SPACING.section} role="alert">
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <p className="font-medium">Could not finish initial setup</p>
            <p className="mt-1 text-destructive/90">{initialSetupCompletionError}</p>
          </div>
        </section>
      ) : null}

      <div className={SPACING.section}>
        <div ref={actionPanelRef}>
          <GuidedStepTransition
            stepKey={displayedGuidedStep}
            direction={guidedTransitionDirection}
            panelRef={actionPanelRef}
          >
            {renderGuidedActionPanel()}
          </GuidedStepTransition>
        </div>
      </div>
    </div>
  );
}
