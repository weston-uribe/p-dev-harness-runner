"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import type { LocalConfigFormInput } from "@harness/setup/config-local-editor";
import { prepareGuidedConfigFormInput } from "@harness/setup/guided-config-form";
import {
  isHarnessRepoInheritedFromStep1,
  isHarnessRepoReadyForGuidedStep4,
} from "@harness/setup/harness-step-readiness";
import type {
  LocalSetupFormPayload,
  LocalSetupPreviewResult,
} from "@harness/setup/local-apply-actions";
import type {
  HarnessRepoProvisioningSummary,
  ServiceConnectionSummaryMap,
  SetupGuiViewModel,
} from "@/lib/setup-server";
import { FORM, SPACING } from "@/lib/constants";
import { GUIDED_SETUP_STEP_COUNT } from "@/lib/guided-setup";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SectionCard } from "@/components/custom/section-card";
import {
  EnvironmentConfigForm,
  INITIAL_SERVICE_VERIFICATION,
  type EnvironmentFormValues,
  type EnvironmentFormPresence,
  type ServiceKey,
  type ServiceVerificationMap,
} from "@/components/custom/environment-config-form";
import {
  GITHUB_REPO_URL_PATTERN,
  TargetRepoConfigForm,
  type RepoVerificationUi,
} from "@/components/custom/target-repo-config-form";
import {
  TargetRepoCreateConnect,
  type TargetRepoCreatedSummary,
  type TargetRepoSelectionMode,
} from "@/components/custom/target-repo-create-connect";
import { LocalWritePreview } from "@/components/custom/local-write-preview";
import { LocalWriteConfirmation } from "@/components/custom/local-write-confirmation";
import { ReviewGeneratedFilesDisclosure } from "@/components/custom/review-generated-files-disclosure";
import { SetupApplyResult } from "@/components/custom/setup-apply-result";
import { GuidedOperationPanel, buildGuidedOperationPhases } from "@/components/custom/guided-operation-panel";
import { GuidedStepSuccessPanel } from "@/components/custom/guided-step-success-panel";
import {
  createGuidedRepoRowId,
  guidedRowsFromConfig,
  guidedRowsToConfigRepos,
  isRepoVerifiedForActiveToken,
  isServiceVerifiedForValue,
  resolveActiveGitHubToken,
  valueFingerprint,
  type GuidedRepoRow,
} from "@/lib/verification-state";
import type { GuidedLocalSetupStep } from "@/lib/guided-setup";

export type GuidedLocalStep = GuidedLocalSetupStep;

interface ConfigureWorkflowProps {
  mode?: "guided" | "advanced";
  guidedStep?: GuidedLocalStep;
  onGuidedStepChange?: (step: GuidedLocalStep) => void;
  initialEnv: {
    harnessConfigPath: string;
    githubDispatchRepository: string;
    savedHarnessDispatchRepository?: string;
    suggestedHarnessDispatchRepo?: string;
    secretPresence: EnvironmentFormPresence;
    serviceConnectionSummaries: ServiceConnectionSummaryMap;
  };
  initialConfig: LocalConfigFormInput;
  initialHarnessProvisioningSummary: HarnessRepoProvisioningSummary;
  highlightStaleDispatch?: boolean;
  highlightStaleTarget?: boolean;
  onSummaryUpdated?: (summary: SetupGuiViewModel) => void;
  onHarnessProvisioningSummaryUpdated?: (
    summary: HarnessRepoProvisioningSummary,
  ) => void;
  onUiStateChange?: (state: { localPreviewStale: boolean }) => void;
  onGuidedLocalApplySuccess?: () => void;
  onConnectServicesComplete?: () => void;
  onConnectServicesSucceeded?: () => void;
  onContinue?: () => void;
  onStepCompleted?: () => void;
  localSetupFilesExist?: boolean;
}

const HARNESS_PROVISIONING_PHASES = [
  "Connecting to GitHub",
  "Repository reconciliation",
  "Object import",
  "Commit creation",
  "Push",
  "Remote verification",
  "Saving configuration",
] as const;

const LEGACY_HARNESS_PROVISIONING_PHASE_LABELS: Record<string, number> = {
  "Creating private workspace": 1,
  "Preparing workspace snapshot": 2,
  "Uploading workspace": 3,
  "Verifying workspace": 5,
  "Saving configuration": 6,
};

const HARNESS_PROVISIONING_PHASE_INDEX = new Map(
  HARNESS_PROVISIONING_PHASES.map((label, index) => [label, index]),
);

function resolveHarnessProvisioningPhaseIndex(message: string | null): number {
  if (!message) {
    return 0;
  }
  const directMatch = HARNESS_PROVISIONING_PHASES.find((label) =>
    message.startsWith(label),
  );
  if (directMatch) {
    return HARNESS_PROVISIONING_PHASE_INDEX.get(directMatch) ?? 0;
  }
  const legacyMatch = Object.entries(LEGACY_HARNESS_PROVISIONING_PHASE_LABELS).find(
    ([label]) => message.startsWith(label),
  );
  return legacyMatch ? legacyMatch[1] : 0;
}

function createHarnessProvisioningOperationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `provision-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const SERVICE_API_MAP: Record<ServiceKey, "linear" | "cursor" | "github" | "vercel"> = {
  LINEAR_API_KEY: "linear",
  CURSOR_API_KEY: "cursor",
  GITHUB_TOKEN: "github",
  VERCEL_TOKEN: "vercel",
};

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

import { serviceVerificationFromSummaries } from "@/lib/verification-state";

export { serviceVerificationFromSummaries };

export function shouldAutoReverifySavedService(input: {
  key: ServiceKey;
  presence: EnvironmentFormPresence;
  envValues: EnvironmentFormValues;
  summaries: ServiceConnectionSummaryMap;
  verification: ServiceVerificationMap;
}): boolean {
  if (!input.presence[input.key]) {
    return false;
  }
  if (input.envValues[SERVICE_VALUE_KEY[input.key]].trim()) {
    return false;
  }
  if (input.verification[input.key].state !== "unchecked") {
    return false;
  }
  const status = input.summaries[input.key]?.status;
  return status === undefined || status === "missing" || status === "unknown" || status === "stale";
}

export function isServiceConnectionReady(input: {
  key: ServiceKey;
  presence: EnvironmentFormPresence;
  verification: ServiceVerificationMap;
  envValues: EnvironmentFormValues;
}): boolean {
  if (!input.presence[input.key]) {
    return false;
  }
  if (input.verification[input.key].state !== "connected") {
    return false;
  }
  const typedValue = input.envValues[SERVICE_VALUE_KEY[input.key]].trim();
  if (typedValue) {
    return isServiceVerifiedForValue(input.verification[input.key], typedValue);
  }
  return true;
}

export function ConfigureWorkflow({
  mode = "advanced",
  guidedStep: guidedStepProp,
  onGuidedStepChange,
  initialEnv,
  initialConfig,
  initialHarnessProvisioningSummary,
  highlightStaleDispatch = false,
  highlightStaleTarget = false,
  onSummaryUpdated,
  onHarnessProvisioningSummaryUpdated,
  onUiStateChange,
  onGuidedLocalApplySuccess,
  onConnectServicesComplete,
  onConnectServicesSucceeded,
  onContinue,
  onStepCompleted,
  localSetupFilesExist = false,
}: ConfigureWorkflowProps) {
  const prefersReducedMotion = useReducedMotion();
  const guidedTopRef = useRef<HTMLDivElement | null>(null);
  const guidedRepoRowCounter = useRef(1);
  const serviceCheckIds = useRef<Record<ServiceKey, number>>({
    LINEAR_API_KEY: 0,
    CURSOR_API_KEY: 0,
    GITHUB_TOKEN: 0,
    VERCEL_TOKEN: 0,
  });
  const inFlightServiceChecks = useRef<
    Partial<
      Record<
        ServiceKey,
        {
          requestKey: string;
          id: number;
          controller: AbortController;
          promise: Promise<void>;
        }
      >
    >
  >({});

  const [internalGuidedStep, setInternalGuidedStep] =
    useState<GuidedLocalStep>("connect-services");
  const guidedStep = guidedStepProp ?? internalGuidedStep;
  const [envValues, setEnvValues] = useState<EnvironmentFormValues>({
    harnessConfigPath: initialEnv.harnessConfigPath,
    githubDispatchRepository:
      initialEnv.githubDispatchRepository ||
      initialEnv.suggestedHarnessDispatchRepo ||
      "",
    linearApiKey: "",
    cursorApiKey: "",
    githubToken: "",
    vercelToken: "",
  });
  const [configValues, setConfigValues] =
    useState<LocalConfigFormInput>(initialConfig);
  const [guidedRepoRows, setGuidedRepoRows] = useState<GuidedRepoRow[]>(() =>
    guidedRowsFromConfig(initialConfig, guidedRepoRowCounter.current),
  );
  const [presence, setPresence] = useState<EnvironmentFormPresence>(
    initialEnv.secretPresence,
  );
  const [serviceVerification, setServiceVerification] =
    useState<ServiceVerificationMap>(() =>
      serviceVerificationFromSummaries(initialEnv.serviceConnectionSummaries),
    );
  const [verifyingServiceKey, setVerifyingServiceKey] =
    useState<ServiceKey | null>(null);
  const [repoVerification, setRepoVerification] = useState<
    Record<string, RepoVerificationUi>
  >({});
  const [verifyingRepoRowId, setVerifyingRepoRowId] = useState<string | null>(
    null,
  );
  const [harnessRepoVerification, setHarnessRepoVerification] = useState<{
    state: "unchecked" | "checking" | "connected" | "failed";
    verifiedRepo?: string;
    verifiedGithubTokenFingerprint?: string;
    message?: string;
    limitation?: string;
  }>({ state: "unchecked" });
  const [autoProvisionedHarnessRepo, setAutoProvisionedHarnessRepo] = useState<
    string | null
  >(null);
  const [serverValidatedHarnessRepo, setServerValidatedHarnessRepo] = useState<
    string | null
  >(null);
  const [step1TrustedHarnessRepo, setStep1TrustedHarnessRepo] = useState<
    string | null
  >(null);
  const [provisioningHarnessRepo, setProvisioningHarnessRepo] = useState(false);
  const [provisioningMessage, setProvisioningMessage] = useState<string | null>(
    null,
  );
  const [provisioningError, setProvisioningError] = useState<string | null>(
    null,
  );
  const [connectServicesSucceeded, setConnectServicesSucceeded] = useState(false);
  const [connectServicesSuccessDetails, setConnectServicesSuccessDetails] = useState<
    string[]
  >([]);
  const [localApplySucceeded, setLocalApplySucceeded] = useState(false);
  const [localApplySuccessDetails, setLocalApplySuccessDetails] = useState<
    string[]
  >([]);
  const provisioningOperationIdRef = useRef<string | null>(null);
  const provisioningClickStartedAtRef = useRef<number | null>(null);
  const [verifyingHarnessRepo, setVerifyingHarnessRepo] = useState(false);
  const [showPreviewDisclosure, setShowPreviewDisclosure] = useState(false);
  const [preview, setPreview] = useState<LocalSetupPreviewResult | null>(null);
  const [previewPayload, setPreviewPayload] =
    useState<LocalSetupFormPayload | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState<"preview" | "apply" | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applySummary, setApplySummary] = useState<SetupGuiViewModel | null>(
    null,
  );
  const [applySuccess, setApplySuccess] = useState<boolean | null>(null);
  const [targetRepoSelectionMode, setTargetRepoSelectionMode] =
    useState<TargetRepoSelectionMode>("create");
  const [githubOwnerLogin, setGithubOwnerLogin] = useState<string | null>(null);
  const [githubOwnerLoading, setGithubOwnerLoading] = useState(false);

  const guidedConfigValues = useMemo<LocalConfigFormInput>(
    () => ({
      ...configValues,
      repos: guidedRowsToConfigRepos(guidedRepoRows),
    }),
    [configValues, guidedRepoRows],
  );

  const preparedConfig = useMemo(
    () =>
      mode === "guided"
        ? prepareGuidedConfigFormInput(guidedConfigValues)
        : configValues,
    [configValues, guidedConfigValues, mode],
  );

  const currentPayload = useMemo<LocalSetupFormPayload>(
    () => ({
      env: envValues,
      config: preparedConfig,
    }),
    [envValues, preparedConfig],
  );

  const previewIsCurrent =
    preview !== null &&
    previewPayload !== null &&
    JSON.stringify(previewPayload) === JSON.stringify(currentPayload);

  useEffect(() => {
    if (mode !== "guided" || guidedStepProp === undefined) {
      return;
    }
    setInternalGuidedStep(guidedStepProp);
  }, [guidedStepProp, mode]);

  useEffect(() => {
    return () => {
      for (const check of Object.values(inFlightServiceChecks.current)) {
        check?.controller.abort();
      }
    };
  }, []);

  useEffect(() => {
    onUiStateChange?.({
      localPreviewStale: preview !== null && !previewIsCurrent,
    });
  }, [onUiStateChange, preview, previewIsCurrent]);

  const setGuidedStep = useCallback(
    (step: GuidedLocalStep) => {
      if (onGuidedStepChange) {
        onGuidedStepChange(step);
        return;
      }
      setInternalGuidedStep(step);
    },
    [onGuidedStepChange],
  );

  const goToGuidedStep = useCallback(
    (nextStep: GuidedLocalStep) => {
      setGuidedStep(nextStep);
      requestAnimationFrame(() => {
        guidedTopRef.current?.scrollIntoView({
          block: "start",
          behavior: prefersReducedMotion ? "auto" : "smooth",
        });
      });
    },
    [prefersReducedMotion, setGuidedStep],
  );

  const serviceConnectionReady = (key: ServiceKey) => {
    return isServiceConnectionReady({
      key,
      presence,
      verification: serviceVerification,
      envValues,
    });
  };

  const connectServicesReady =
    serviceConnectionReady("LINEAR_API_KEY") &&
    serviceConnectionReady("CURSOR_API_KEY") &&
    serviceConnectionReady("GITHUB_TOKEN") &&
    serviceConnectionReady("VERCEL_TOKEN");

  const servicesPersistedReady =
    presence.LINEAR_API_KEY &&
    presence.CURSOR_API_KEY &&
    presence.GITHUB_TOKEN &&
    presence.VERCEL_TOKEN;

  const isGuidedLocalSetupStep =
    mode === "guided" && guidedStep === "choose-target-repos";

  const activeGithubToken = useMemo(
    () =>
      resolveActiveGitHubToken({
        typedToken: envValues.githubToken,
        hasSavedToken: presence.GITHUB_TOKEN,
      }),
    [envValues.githubToken, presence.GITHUB_TOKEN],
  );

  const guidedRepos =
    preparedConfig.repos.length > 0
      ? preparedConfig.repos
      : [{ id: "", targetRepo: "" }];

  const targetReposReady = guidedRepoRows.every((repo) =>
    GITHUB_REPO_URL_PATTERN.test(repo.targetRepo.trim()),
  );

  const allReposVerified = guidedRepoRows.every((row) =>
    isRepoVerifiedForActiveToken(
      repoVerification[row.rowId],
      row.targetRepo.trim(),
      activeGithubToken?.fingerprint ?? null,
    ),
  );

  const effectiveHarnessDispatchRepo =
    envValues.githubDispatchRepository.trim() ||
    initialEnv.savedHarnessDispatchRepository?.trim() ||
    "";

  const harnessRepoInheritedFromStep1 = isHarnessRepoInheritedFromStep1(
    effectiveHarnessDispatchRepo,
    step1TrustedHarnessRepo,
  );

  const harnessRepoReady = isHarnessRepoReadyForGuidedStep4({
    effectiveRepo: effectiveHarnessDispatchRepo,
    step1TrustedRepo: step1TrustedHarnessRepo,
    serverValidatedRepo: serverValidatedHarnessRepo,
    manualVerification: harnessRepoVerification,
    activeGithubTokenFingerprint: activeGithubToken?.fingerprint ?? null,
  });

  useEffect(() => {
    if (mode !== "guided" || guidedStep !== "choose-target-repos") {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/setup/harness-provisioning-summary");
        const data = await response.json();
        if (!response.ok || cancelled) {
          return;
        }

        if (data.verifiedSavedRepo && data.harnessDispatchRepo) {
          setStep1TrustedHarnessRepo(data.harnessDispatchRepo);
          setServerValidatedHarnessRepo(data.harnessDispatchRepo);
          setEnvValues((current) => ({
            ...current,
            githubDispatchRepository: data.harnessDispatchRepo,
          }));
          if (data.connectedAutomatically) {
            setAutoProvisionedHarnessRepo(data.harnessDispatchRepo);
          }
          setHarnessRepoVerification({
            state: "connected",
            verifiedRepo: data.harnessDispatchRepo,
            message: data.message,
          });
        } else {
          setServerValidatedHarnessRepo(null);
          setStep1TrustedHarnessRepo(null);
        }
      } catch {
        if (!cancelled) {
          setServerValidatedHarnessRepo(null);
          setStep1TrustedHarnessRepo(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [guidedStep, mode]);

  useEffect(() => {
    if (mode !== "guided" || guidedStep !== "choose-target-repos") {
      return;
    }
    if (!presence.GITHUB_TOKEN) {
      setGithubOwnerLogin(null);
      return;
    }

    let cancelled = false;
    setGithubOwnerLoading(true);
    void (async () => {
      try {
        const response = await fetch("/api/setup/verify-service", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: "github" }),
        });
        const data = await response.json();
        if (cancelled) {
          return;
        }
        if (response.ok && data.status === "connected" && data.label) {
          setGithubOwnerLogin(String(data.label));
        } else {
          setGithubOwnerLogin(null);
        }
      } catch {
        if (!cancelled) {
          setGithubOwnerLogin(null);
        }
      } finally {
        if (!cancelled) {
          setGithubOwnerLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [guidedStep, mode, presence.GITHUB_TOKEN]);

  useEffect(() => {
    if (serverValidatedHarnessRepo || autoProvisionedHarnessRepo || step1TrustedHarnessRepo) {
      return;
    }
    setHarnessRepoVerification({ state: "unchecked" });
  }, [
    activeGithubToken?.fingerprint,
    autoProvisionedHarnessRepo,
    serverValidatedHarnessRepo,
    step1TrustedHarnessRepo,
  ]);

  const continueWithHarnessProvisioning = useCallback(async () => {
    const markConnectServicesSucceeded = (details: string[]) => {
      setConnectServicesSuccessDetails(details);
      setConnectServicesSucceeded(true);
      onConnectServicesSucceeded?.();
    };

    if (
      initialHarnessProvisioningSummary.state === "verified-and-persisted" ||
      initialHarnessProvisioningSummary.state === "skipped-source-mode" ||
      initialHarnessProvisioningSummary.state === "skipped-not-packaged"
    ) {
      const repoSlug = initialHarnessProvisioningSummary.harnessDispatchRepo;
      if (repoSlug) {
        setStep1TrustedHarnessRepo(repoSlug);
        setServerValidatedHarnessRepo(repoSlug);
        setHarnessRepoVerification({
          state: "connected",
          verifiedRepo: repoSlug,
          message: initialHarnessProvisioningSummary.message,
        });
      }
      markConnectServicesSucceeded([
        repoSlug
          ? `Workspace reconnected: ${repoSlug}`
          : "Workspace already verified",
        "Configuration saved",
      ]);
      return;
    }

    setProvisioningHarnessRepo(true);
    setProvisioningError(null);
    setConnectServicesSucceeded(false);
    setConnectServicesSuccessDetails([]);
    const operationId =
      provisioningOperationIdRef.current ?? createHarnessProvisioningOperationId();
    provisioningOperationIdRef.current = operationId;
    provisioningClickStartedAtRef.current = performance.now();
    setProvisioningMessage(HARNESS_PROVISIONING_PHASES[0]);

    let progressPoll: ReturnType<typeof setInterval> | undefined;
    try {
      const previewResponse = await fetch(
        "/api/setup/preview-harness-repo-provisioning",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operationId }),
        },
      );
      const previewData = await previewResponse.json();
      if (!previewResponse.ok) {
        throw new Error(previewData.error ?? "Provisioning preview failed");
      }

      if (previewData.state === "skipped-not-packaged") {
        const trustedRepo =
          envValues.githubDispatchRepository.trim() ||
          initialEnv.savedHarnessDispatchRepository?.trim() ||
          initialEnv.suggestedHarnessDispatchRepo?.trim() ||
          "";
        if (trustedRepo) {
          setStep1TrustedHarnessRepo(trustedRepo);
          setServerValidatedHarnessRepo(trustedRepo);
        }
        onHarnessProvisioningSummaryUpdated?.({
          ...initialHarnessProvisioningSummary,
          state: "skipped-not-packaged",
          harnessDispatchRepo: trustedRepo || null,
          message: previewData.message,
          recoverable: false,
        });
        markConnectServicesSucceeded([
          trustedRepo
            ? `Workspace reconnected: ${trustedRepo}`
            : "Workspace setup skipped for source mode",
          "Configuration saved",
        ]);
        return;
      }

      progressPoll = setInterval(() => {
        void fetch("/api/setup/harness-provisioning-progress")
          .then(async (response) => {
            if (!response.ok) {
              return;
            }
            const report = (await response.json()) as {
              uiPhaseLabel?: string | null;
              operationId?: string | null;
              completed?: number | null;
              total?: number | null;
            };
            if (report.uiPhaseLabel) {
              const counts =
                typeof report.completed === "number" &&
                typeof report.total === "number" &&
                report.total > 0
                  ? ` (${report.completed}/${report.total})`
                  : "";
              setProvisioningMessage(`${report.uiPhaseLabel}${counts}`);
            }
          })
          .catch(() => {
            // Progress polling is best-effort; apply response remains authoritative.
          });
      }, 1_000);

      const applyController = new AbortController();
      const applyTimeoutMs = 180_000;
      const applyTimer = setTimeout(() => applyController.abort(), applyTimeoutMs);
      let applyResponse: Response;
      try {
        applyResponse = await fetch(
          "/api/setup/apply-harness-repo-provisioning",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              confirmed: true,
              fingerprint: previewData.fingerprint,
              operationId: previewData.operationId ?? operationId,
            }),
            signal: applyController.signal,
          },
        );
      } catch (fetchError) {
        if (
          fetchError instanceof DOMException &&
          fetchError.name === "AbortError"
        ) {
          setProvisioningError(
            `Workspace setup timed out after ${Math.round(applyTimeoutMs / 1000)}s. Operation ID: ${previewData.operationId}. Retry Step 1 Continue to resume or reconcile — the repository may already exist.`,
          );
          return;
        }
        throw fetchError;
      } finally {
        clearTimeout(applyTimer);
      }
      const applyData = await applyResponse.json();
      if (!applyResponse.ok) {
        throw new Error(applyData.error ?? "Provisioning apply failed");
      }

      if (applyData.apply.state !== "verified-and-persisted") {
        if (applyData.apply.recoverable) {
          const phaseHint = applyData.apply.uiPhaseLabel
            ? ` (${applyData.apply.uiPhaseLabel})`
            : "";
          const opHint = applyData.apply.operationId
            ? ` Operation ID: ${applyData.apply.operationId}.`
            : ` Operation ID: ${previewData.operationId}.`;
          setProvisioningError(
            `${applyData.apply.message}${phaseHint}.${opHint} Retry will resume or reconcile.`,
          );
          return;
        }
        throw new Error(
          applyData.apply.message ?? "Harness workspace provisioning did not complete.",
        );
      }

      const repoSlug = applyData.apply.harnessDispatchRepo as string | null;
      if (repoSlug) {
        setStep1TrustedHarnessRepo(repoSlug);
        setAutoProvisionedHarnessRepo(repoSlug);
        setEnvValues((current) => ({
          ...current,
          githubDispatchRepository: repoSlug,
        }));
        setHarnessRepoVerification({
          state: "connected",
          verifiedRepo: repoSlug,
          message: applyData.apply.message,
        });
      }

      onHarnessProvisioningSummaryUpdated?.({
        ...initialHarnessProvisioningSummary,
        state: applyData.apply.state,
        harnessDispatchRepo: repoSlug,
        message: applyData.apply.message,
        recoverable: applyData.apply.recoverable,
        verifiedSavedRepo: applyData.apply.state === "verified-and-persisted",
        connectedAutomatically: Boolean(repoSlug),
      });
      onSummaryUpdated?.(applyData.summary as SetupGuiViewModel);
      try {
        const summaryResponse = await fetch(
          "/api/setup/harness-provisioning-summary",
        );
        const summaryData = await summaryResponse.json();
        if (summaryResponse.ok) {
          onHarnessProvisioningSummaryUpdated?.(
            summaryData as HarnessRepoProvisioningSummary,
          );
        }
      } catch {
        // The apply result already advanced the UI; a refresh will reload summary.
      }
      setProvisioningMessage(applyData.apply.message);
      const clickToSuccessMs =
        provisioningClickStartedAtRef.current !== null
          ? Math.round(performance.now() - provisioningClickStartedAtRef.current)
          : undefined;
      markConnectServicesSucceeded([
        repoSlug
          ? `Workspace created or reconnected: ${repoSlug}`
          : "Workspace verified",
        "Snapshot uploaded",
        "Workspace verified",
        "Configuration saved",
        ...(clickToSuccessMs !== undefined
          ? [`Browser click-to-success: ${clickToSuccessMs}ms`]
          : []),
      ]);
    } catch (provisionError) {
      setProvisioningError(
        provisionError instanceof Error
          ? provisionError.message
          : "Harness workspace provisioning failed",
      );
    } finally {
      if (progressPoll) {
        clearInterval(progressPoll);
      }
      setProvisioningHarnessRepo(false);
    }
  }, [
    envValues.githubDispatchRepository,
    initialEnv.savedHarnessDispatchRepository,
    initialEnv.suggestedHarnessDispatchRepo,
    initialHarnessProvisioningSummary,
    onConnectServicesSucceeded,
    onHarnessProvisioningSummaryUpdated,
    onSummaryUpdated,
  ]);

  const resetApplyState = () => {
    setApplySuccess(null);
    setApplySummary(null);
    setError(null);
  };

  const invalidatePreview = useCallback(() => {
    resetApplyState();
    setPreview(null);
    setPreviewPayload(null);
    setPreviewError(null);
    setConfirmed(false);
    setLocalApplySucceeded(false);
    setLocalApplySuccessDetails([]);
  }, []);

  const markServiceUnchecked = (key: ServiceKey) => {
    setServiceVerification((current) => ({
      ...current,
      [key]: { state: "unchecked" },
    }));
  };

  const clearAllRepoVerification = useCallback(() => {
    setRepoVerification({});
  }, []);

  const resetRepoVerificationIfUrlChanged = useCallback(
    (rows: GuidedRepoRow[]) => {
      setRepoVerification((current) => {
        const next = { ...current };
        for (const row of rows) {
          const existing = current[row.rowId];
          if (!existing) {
            continue;
          }
          const trimmedUrl = row.targetRepo.trim();
          if (
            existing.verifiedTargetRepo &&
            existing.verifiedTargetRepo !== trimmedUrl
          ) {
            next[row.rowId] = { state: "unchecked" };
          } else if (
            existing.attemptedTargetRepo &&
            existing.attemptedTargetRepo !== trimmedUrl
          ) {
            next[row.rowId] = { state: "unchecked" };
          }
        }
        return next;
      });
    },
    [],
  );

  const saveConnectServiceKey = useCallback(
    async (key: ServiceKey) => {
      const previewResponse = await fetch("/api/setup/preview-connect-services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envValues),
      });
      const previewData = await previewResponse.json();
      if (!previewResponse.ok) {
        throw new Error(previewData.error ?? "Preview failed");
      }

      const response = await fetch("/api/setup/apply-connect-services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          env: envValues,
          confirmed: true,
          fingerprint: previewData.fingerprint,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Save failed");
      }

      onSummaryUpdated?.(data.summary as SetupGuiViewModel);
      setPresence({
        LINEAR_API_KEY: data.summary.envKeyPresence.LINEAR_API_KEY,
        CURSOR_API_KEY: data.summary.envKeyPresence.CURSOR_API_KEY,
        GITHUB_TOKEN: data.summary.envKeyPresence.GITHUB_TOKEN,
        VERCEL_TOKEN: data.summary.envKeyPresence.VERCEL_TOKEN,
      });
      setEnvValues((current) => ({
        ...current,
        [SERVICE_VALUE_KEY[key]]: "",
      }));
    },
    [envValues, onSummaryUpdated],
  );

  const runServiceVerification = useCallback(
    async (
      key: ServiceKey,
      options: { saveOnConnected: boolean },
    ) => {
      const token = envValues[SERVICE_VALUE_KEY[key]].trim();
      const fingerprint = token ? valueFingerprint(token) : undefined;
      const requestKey = token ? `typed:${fingerprint}` : "saved";
      const existing = inFlightServiceChecks.current[key];
      if (existing?.requestKey === requestKey) {
        return existing.promise;
      }

      existing?.controller.abort();
      const controller = new AbortController();
      const requestId = serviceCheckIds.current[key] + 1;
      serviceCheckIds.current[key] = requestId;

      setVerifyingServiceKey(key);
      setServiceVerification((current) => ({
        ...current,
        [key]: { state: "checking" },
      }));

      const promise = (async () => {
        const response = await fetch("/api/setup/verify-service", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            service: SERVICE_API_MAP[key],
            ...(token ? { token } : {}),
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Verification failed");
        }

        if (serviceCheckIds.current[key] !== requestId) {
          return;
        }

        if (data.status !== "connected") {
          setServiceVerification((current) => ({
            ...current,
            [key]: {
              state: "failed",
              attemptedValueFingerprint: fingerprint,
              message: data.message,
              limitation: data.limitation,
              label: data.label,
            },
          }));
          return;
        }

        if (token && options.saveOnConnected) {
          await saveConnectServiceKey(key);
        }

        if (serviceCheckIds.current[key] !== requestId) {
          return;
        }

        setServiceVerification((current) => ({
          ...current,
          [key]: {
            state: "connected",
            verifiedValueFingerprint: fingerprint,
            message: data.message,
            limitation: data.limitation,
            label: data.label,
          },
        }));
      })();

      inFlightServiceChecks.current[key] = {
        requestKey,
        id: requestId,
        controller,
        promise,
      };

      try {
        await promise;
      } catch (verifyError) {
        if (
          controller.signal.aborted ||
          serviceCheckIds.current[key] !== requestId
        ) {
          return;
        }
        setServiceVerification((current) => ({
          ...current,
          [key]: {
            state: "failed",
            attemptedValueFingerprint: fingerprint,
            message:
              verifyError instanceof Error
                ? verifyError.message
                : "Verification failed",
          },
        }));
      } finally {
        if (inFlightServiceChecks.current[key]?.id === requestId) {
          delete inFlightServiceChecks.current[key];
        }
        if (serviceCheckIds.current[key] === requestId) {
          setVerifyingServiceKey(null);
        }
      }
    },
    [envValues, saveConnectServiceKey],
  );

  const verifyAndSaveService = useCallback(
    async (key: ServiceKey) => {
      await runServiceVerification(key, {
        saveOnConnected: true,
      });
    },
    [runServiceVerification],
  );

  useEffect(() => {
    if (mode !== "guided" || guidedStep !== "connect-services") {
      return;
    }

    for (const key of Object.keys(SERVICE_VALUE_KEY) as ServiceKey[]) {
      if (
        shouldAutoReverifySavedService({
          key,
          presence,
          envValues,
          summaries: initialEnv.serviceConnectionSummaries,
          verification: serviceVerification,
        })
      ) {
        void runServiceVerification(key, {
          saveOnConnected: false,
        });
      }
    }
  }, [
    envValues,
    guidedStep,
    initialEnv.serviceConnectionSummaries,
    mode,
    presence,
    runServiceVerification,
    serviceVerification,
  ]);

  const verifyAndUseHarnessRepo = useCallback(
    async (draftRepo: string) => {
      const harnessDispatchRepo = draftRepo.trim();
      const tokenContext = resolveActiveGitHubToken({
        typedToken: envValues.githubToken,
        hasSavedToken: presence.GITHUB_TOKEN,
      });
      const tokenFingerprint = tokenContext?.fingerprint ?? null;

      setVerifyingHarnessRepo(true);
      setHarnessRepoVerification({ state: "checking" });

      try {
        const response = await fetch("/api/setup/verify-harness-repo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            harnessDispatchRepo,
            ...(tokenContext?.tokenForRequest
              ? { githubToken: tokenContext.tokenForRequest }
              : {}),
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Harness repo verification failed");
        }

        if (data.status === "connected" && data.repoSlug) {
          invalidatePreview();
          setEnvValues((current) => ({
            ...current,
            githubDispatchRepository: data.repoSlug,
          }));
          setHarnessRepoVerification({
            state: "connected",
            verifiedRepo: data.repoSlug,
            verifiedGithubTokenFingerprint: tokenFingerprint ?? undefined,
            message: data.message,
            limitation: data.limitation,
          });
        } else {
          setHarnessRepoVerification({
            state: "failed",
            message: data.message,
            limitation: data.limitation,
          });
        }
      } catch (verifyError) {
        setHarnessRepoVerification({
          state: "failed",
          message:
            verifyError instanceof Error
              ? verifyError.message
              : "Harness repo verification failed",
        });
      } finally {
        setVerifyingHarnessRepo(false);
      }
    },
    [
      envValues.githubToken,
      invalidatePreview,
      presence.GITHUB_TOKEN,
    ],
  );

  const verifyRepo = useCallback(
    async (rowId: string) => {
      const repo = guidedRepoRows.find((row) => row.rowId === rowId);
      if (!repo) {
        return;
      }

      const targetRepo = repo.targetRepo.trim();
      const tokenContext = resolveActiveGitHubToken({
        typedToken: envValues.githubToken,
        hasSavedToken: presence.GITHUB_TOKEN,
      });
      const tokenFingerprint = tokenContext?.fingerprint ?? null;

      setVerifyingRepoRowId(rowId);
      setRepoVerification((current) => ({
        ...current,
        [rowId]: { state: "checking" },
      }));

      try {
        const response = await fetch("/api/setup/verify-target-repo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetRepo,
            ...(tokenContext?.tokenForRequest
              ? { githubToken: tokenContext.tokenForRequest }
              : {}),
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Repo verification failed");
        }

        setRepoVerification((current) => ({
          ...current,
          [rowId]:
            data.status === "connected" && data.workflowInstallReady !== false
              ? {
                  state: "connected",
                  verifiedTargetRepo: targetRepo,
                  verifiedGithubTokenFingerprint: tokenFingerprint ?? undefined,
                  message: data.message,
                  repoSlug: data.repoSlug,
                  limitation: data.limitation,
                  workflowInstallReady: data.workflowInstallReady,
                }
              : {
                  state: "failed",
                  attemptedTargetRepo: targetRepo,
                  attemptedGithubTokenFingerprint: tokenFingerprint ?? undefined,
                  message: data.message,
                  repoSlug: data.repoSlug,
                  limitation: data.limitation,
                  workflowInstallReady: data.workflowInstallReady,
                },
        }));
      } catch (verifyError) {
        setRepoVerification((current) => ({
          ...current,
          [rowId]: {
            state: "failed",
            attemptedTargetRepo: targetRepo,
            attemptedGithubTokenFingerprint: tokenFingerprint ?? undefined,
            message:
              verifyError instanceof Error
                ? verifyError.message
                : "Repo verification failed",
          },
        }));
      } finally {
        setVerifyingRepoRowId(null);
      }
    },
    [envValues.githubToken, guidedRepoRows, presence.GITHUB_TOKEN],
  );

  const handleTargetRepoCreated = useCallback(
    (summary: TargetRepoCreatedSummary) => {
      invalidatePreview();
      const rowId =
        guidedRepoRows[0]?.rowId ??
        createGuidedRepoRowId(guidedRepoRowCounter.current);
      const nextRow: GuidedRepoRow = {
        rowId,
        id: summary.resultingTargetRepoConfigId,
        targetRepo: summary.repositoryUrl,
        baseBranch: "dev",
        productionBranch: "main",
        previewProvider: "none",
      };
      setGuidedRepoRows([nextRow]);
      setConfigValues((current) => ({
        ...current,
        repos: [
          {
            id: summary.resultingTargetRepoConfigId,
            targetRepo: summary.repositoryUrl,
            baseBranch: "dev",
            productionBranch: "main",
            previewProvider: "none",
          },
        ],
      }));
      setRepoVerification({
        [rowId]: {
          state: "connected",
          verifiedTargetRepo: summary.repositoryUrl,
          verifiedGithubTokenFingerprint:
            activeGithubToken?.fingerprint ?? undefined,
          message: "Repository created and ready for local config.",
          repoSlug: summary.repositoryFullName,
          workflowInstallReady: false,
        },
      });
      setTargetRepoSelectionMode("connect");
    },
    [activeGithubToken?.fingerprint, guidedRepoRows, invalidatePreview],
  );

  const handleServiceBlur = useCallback(
    (key: ServiceKey) => {
      const value = envValues[SERVICE_VALUE_KEY[key]].trim();
      if (!value) {
        return;
      }
      if (isServiceVerifiedForValue(serviceVerification[key], value)) {
        return;
      }
      void verifyAndSaveService(key);
    },
    [envValues, serviceVerification, verifyAndSaveService],
  );

  const handleRepoBlur = useCallback(
    (rowId: string) => {
      const repo = guidedRepoRows.find((row) => row.rowId === rowId);
      if (!repo || !GITHUB_REPO_URL_PATTERN.test(repo.targetRepo.trim())) {
        return;
      }
      if (
        isRepoVerifiedForActiveToken(
          repoVerification[rowId],
          repo.targetRepo.trim(),
          activeGithubToken?.fingerprint ?? null,
        )
      ) {
        return;
      }
      void verifyRepo(rowId);
    },
    [activeGithubToken?.fingerprint, guidedRepoRows, repoVerification, verifyRepo],
  );

  const runPreview = useCallback(async (): Promise<LocalSetupPreviewResult> => {
    const response = await fetch("/api/setup/preview-local-files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentPayload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Preview failed");
    }
    const result = data as LocalSetupPreviewResult;
    setPreview(result);
    setPreviewPayload(currentPayload);
    return result;
  }, [currentPayload]);

  const handlePreview = useCallback(async () => {
    setLoading("preview");
    setPreviewError(null);
    setConfirmed(false);
    try {
      await runPreview();
      setShowPreviewDisclosure(true);
    } catch (previewFailure) {
      setPreview(null);
      setPreviewPayload(null);
      setPreviewError(
        previewFailure instanceof Error
          ? previewFailure.message
          : "Preview failed",
      );
      setShowPreviewDisclosure(true);
    } finally {
      setLoading(null);
    }
  }, [runPreview]);

  const handlePreviewDisclosureOpenChange = useCallback(
    (open: boolean) => {
      setShowPreviewDisclosure(open);
      if (open && !previewIsCurrent && loading !== "preview") {
        void handlePreview();
      }
    },
    [handlePreview, loading, previewIsCurrent],
  );

  const handleApply = async () => {
    if (isGuidedLocalSetupStep) {
      if (!confirmed) {
        return;
      }
    } else if (!preview || !previewIsCurrent || !confirmed) {
      return;
    }

    setLoading("apply");
    resetApplyState();
    try {
      const applyPreview = isGuidedLocalSetupStep
        ? previewIsCurrent && preview
          ? preview
          : await runPreview()
        : preview;
      if (!applyPreview) {
        throw new Error("Preview failed");
      }
      if (applyPreview.validationError) {
        throw new Error(applyPreview.validationError);
      }

      const response = await fetch("/api/setup/apply-local-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...currentPayload,
          confirmed: true,
          fingerprint: applyPreview.fingerprint,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Apply failed");
      }

      onSummaryUpdated?.(data.summary as SetupGuiViewModel);
      setPresence({
        LINEAR_API_KEY: data.summary.envKeyPresence.LINEAR_API_KEY,
        CURSOR_API_KEY: data.summary.envKeyPresence.CURSOR_API_KEY,
        GITHUB_TOKEN: data.summary.envKeyPresence.GITHUB_TOKEN,
        VERCEL_TOKEN: data.summary.envKeyPresence.VERCEL_TOKEN,
      });
      setEnvValues((current) => ({
        ...current,
        linearApiKey: "",
        cursorApiKey: "",
        githubToken: "",
        vercelToken: "",
      }));
      setPreview(null);
      setPreviewPayload(null);
      setConfirmed(false);
      setShowPreviewDisclosure(false);

      if (mode === "guided") {
        setLocalApplySucceeded(true);
        setLocalApplySuccessDetails([
          localSetupFilesExist
            ? "Local setup files updated on this machine."
            : "Local setup files created on this machine.",
          `.env.local and .harness/config.local.json are ready.`,
        ]);
        onGuidedLocalApplySuccess?.();
        onStepCompleted?.();
      } else {
        setApplySuccess(true);
        setApplySummary(data.summary as SetupGuiViewModel);
      }
    } catch (applyError) {
      setApplySuccess(false);
      setError(
        applyError instanceof Error ? applyError.message : "Apply failed",
      );
    } finally {
      setLoading(null);
    }
  };

  const handleCreateSetupFiles = async () => {
    await handleApply();
  };

  const previewDisabledReason =
    loading !== null ? "Wait for the current action to finish." : undefined;
  const confirmDisabledReason = !previewIsCurrent
    ? "Generate a preview before you can confirm this write."
    : preview?.validationError
      ? "Fix validation errors before confirming this write."
      : undefined;
  const guidedConfirmDisabledReason = preview?.validationError
    ? "Fix validation errors before confirming this write."
    : undefined;
  const applyDisabledReason =
    confirmDisabledReason ??
    (!confirmed
      ? "Confirm that you understand local setup files will be created on this machine."
      : undefined);

  const canCreateSetupFiles =
    loading === null &&
    servicesPersistedReady &&
    targetReposReady &&
    allReposVerified &&
    harnessRepoReady &&
    confirmed;

  const guidedApplyBlockedReason =
    loading !== null
      ? "Wait for the current action to finish."
      : !servicesPersistedReady
        ? "Complete Step 1 service setup before creating local files."
        : !targetReposReady
          ? "Enter a valid GitHub target repo URL for each repo row to continue."
          : !allReposVerified
            ? `Verify access for each target repo before ${
                localSetupFilesExist ? "updating" : "creating"
              } setup files.`
            : !harnessRepoReady
              ? effectiveHarnessDispatchRepo
                ? "Verify and use your harness repo before creating local setup files."
                : "Complete Step 1 harness workspace setup before creating local setup files."
              : !confirmed
              ? `Confirm that you understand local setup files will be ${
                  localSetupFilesExist ? "updated" : "created"
                } on this machine.`
              : preview?.validationError
                ? "Fix validation errors before creating setup files."
                : undefined;

  const guidedLocalSetupActionLabel = localSetupFilesExist
    ? "Update local setup files"
    : "Create local setup files";
  const guidedLocalSetupActionLoadingLabel = localSetupFilesExist
    ? "Updating…"
    : "Creating…";
  const harnessProvisioningActiveIndex =
    provisioningHarnessRepo
      ? resolveHarnessProvisioningPhaseIndex(provisioningMessage)
      : HARNESS_PROVISIONING_PHASES.length;

  if (mode === "guided") {
    const renderGuidedStep = () => {
      switch (guidedStep) {
        case "connect-services":
          return (
            <SectionCard
              title={`Step 1 of ${GUIDED_SETUP_STEP_COUNT} · Connect services`}
              description="Add the API keys the harness needs on this machine."
            >
              <EnvironmentConfigForm
                values={envValues}
                presence={presence}
                variant="guided-services"
                verification={serviceVerification}
                verifyingKey={verifyingServiceKey}
                onChange={(values) => {
                  invalidatePreview();
                  setConnectServicesSucceeded(false);
                  setConnectServicesSuccessDetails([]);
                  setEnvValues(values);
                  if (values.linearApiKey !== envValues.linearApiKey) {
                    markServiceUnchecked("LINEAR_API_KEY");
                  }
                  if (values.cursorApiKey !== envValues.cursorApiKey) {
                    markServiceUnchecked("CURSOR_API_KEY");
                  }
                  if (values.githubToken !== envValues.githubToken) {
                    markServiceUnchecked("GITHUB_TOKEN");
                    clearAllRepoVerification();
                  }
                  if (values.vercelToken !== envValues.vercelToken) {
                    markServiceUnchecked("VERCEL_TOKEN");
                  }
                }}
                onVerifyService={verifyAndSaveService}
                onServiceBlur={handleServiceBlur}
              />
              {provisioningHarnessRepo ? (
                <GuidedOperationPanel
                  phases={buildGuidedOperationPhases({
                    labels: [...HARNESS_PROVISIONING_PHASES],
                    activeIndex: harnessProvisioningActiveIndex,
                  })}
                  supportingText={provisioningMessage ?? HARNESS_PROVISIONING_PHASES[0]}
                />
              ) : null}
              {!provisioningHarnessRepo && !connectServicesSucceeded ? (
                <>
                  <div className={FORM.actions}>
                    <Button
                      type="button"
                      onClick={() => {
                        void continueWithHarnessProvisioning();
                      }}
                      disabled={!connectServicesReady}
                    >
                      Set up workspace
                    </Button>
                  </div>
                  {!connectServicesReady ? (
                    <p className="text-sm text-muted-foreground">
                      Verify and save each service key above. Continue unlocks after
                      all four services are verified and saved locally.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      p-dev will use your GitHub token to create or reconnect your
                      private `p-dev-harness` workspace before continuing.
                    </p>
                  )}
                </>
              ) : null}
              {!provisioningHarnessRepo && connectServicesSucceeded ? (
                <GuidedStepSuccessPanel
                  heading="Workspace setup verified"
                  explanation="Your private harness workspace and local service configuration are ready."
                  details={connectServicesSuccessDetails}
                  continueLabel="Continue to Linear workspace"
                  onContinue={onConnectServicesComplete ?? (() => undefined)}
                />
              ) : null}
              {provisioningError ? (
                <p className="text-sm text-destructive">{provisioningError}</p>
              ) : null}
            </SectionCard>
          );
        case "choose-target-repos":
          return (
            <SectionCard
              title={`Step 4 of ${GUIDED_SETUP_STEP_COUNT} · Choose target repo(s) and create setup files`}
              description="Create a new product repository or connect an existing GitHub repo, then preview and confirm local setup files on this machine."
            >
              <TargetRepoConfigForm
                values={guidedConfigValues}
                highlightStaleTarget={highlightStaleTarget}
                variant="guided-minimal"
                guidedSection="harness"
                harnessDispatchRepository={envValues.githubDispatchRepository}
                savedHarnessDispatchRepository={
                  initialEnv.savedHarnessDispatchRepository
                }
                suggestedHarnessDispatchRepo={
                  initialEnv.suggestedHarnessDispatchRepo
                }
                harnessRepoVerification={harnessRepoVerification}
                verifyingHarnessRepo={verifyingHarnessRepo}
                onHarnessDispatchRepositoryChange={(value) => {
                  invalidatePreview();
                  setHarnessRepoVerification({ state: "unchecked" });
                  setEnvValues((current) => ({
                    ...current,
                    githubDispatchRepository: value,
                  }));
                }}
                onVerifyAndUseHarnessRepo={(draftRepo) => {
                  void verifyAndUseHarnessRepo(draftRepo);
                }}
                harnessConnectedAutomatically={
                  autoProvisionedHarnessRepo === effectiveHarnessDispatchRepo &&
                  serverValidatedHarnessRepo === effectiveHarnessDispatchRepo &&
                  Boolean(effectiveHarnessDispatchRepo)
                }
                harnessRepoInheritedFromStep1={harnessRepoInheritedFromStep1}
                onChange={(values) => {
                  invalidatePreview();
                  setConfigValues(values);
                }}
              />

              <TargetRepoCreateConnect
                mode={targetRepoSelectionMode}
                onModeChange={setTargetRepoSelectionMode}
                githubOwner={githubOwnerLogin}
                githubOwnerLoading={githubOwnerLoading}
                onRepoCreated={handleTargetRepoCreated}
                onInvalidatePreview={invalidatePreview}
                connectContent={
                  <TargetRepoConfigForm
                    values={guidedConfigValues}
                    highlightStaleTarget={highlightStaleTarget}
                    variant="guided-minimal"
                    guidedSection="target-repos"
                    guidedRepos={guidedRepoRows}
                    repoVerification={repoVerification}
                    verifyingRepoRowId={verifyingRepoRowId}
                    onChange={(values) => {
                      invalidatePreview();
                      setConfigValues(values);
                    }}
                    onGuidedReposChange={(rows) => {
                      invalidatePreview();
                      resetRepoVerificationIfUrlChanged(rows);
                      setGuidedRepoRows(rows);
                    }}
                    onVerifyRepo={verifyRepo}
                    onRepoBlur={handleRepoBlur}
                    activeGithubTokenFingerprint={
                      activeGithubToken?.fingerprint ?? null
                    }
                    onAddRepo={() => {
                      invalidatePreview();
                      guidedRepoRowCounter.current += 1;
                      const rowId = createGuidedRepoRowId(
                        guidedRepoRowCounter.current,
                      );
                      setGuidedRepoRows((current) => [
                        ...current,
                        { rowId, id: "", targetRepo: "" },
                      ]);
                    }}
                    onRemoveRepo={(rowId) => {
                      invalidatePreview();
                      setGuidedRepoRows((current) =>
                        current.filter((row) => row.rowId !== rowId),
                      );
                      setRepoVerification((current) => {
                        const next = { ...current };
                        delete next[rowId];
                        return next;
                      });
                    }}
                  />
                }
              />

              <Separator className="my-6" />

              <div className="rounded-md border border-border bg-muted/20 p-4 space-y-3">
                <p className="text-sm font-medium">{guidedLocalSetupActionLabel}</p>
                <p className="text-sm text-muted-foreground">
                  {localSetupFilesExist
                    ? "Local gitignored setup files already exist on this machine. Preview the changes, confirm, and update `.env.local` and `.harness/config.local.json`."
                    : "This is the point where the app writes local gitignored setup files to this machine: `.env.local` and `.harness/config.local.json`."}
                </p>

                <ReviewGeneratedFilesDisclosure
                  open={showPreviewDisclosure}
                  onOpenChange={handlePreviewDisclosureOpenChange}
                  isLoading={loading === "preview"}
                  previewError={previewError ?? undefined}
                  envPreview={previewIsCurrent ? preview?.envPreview : undefined}
                  configPreview={
                    previewIsCurrent ? preview?.configPreview : undefined
                  }
                  validationError={
                    previewIsCurrent ? preview?.validationError : undefined
                  }
                  previewIsCurrent={previewIsCurrent}
                />

                <LocalWriteConfirmation
                  variant="guided"
                  intent={localSetupFilesExist ? "update" : "create"}
                  plan={previewIsCurrent ? preview?.plan : undefined}
                  confirmed={confirmed}
                  disabled={Boolean(preview?.validationError)}
                  disabledReason={guidedConfirmDisabledReason}
                  onConfirmedChange={setConfirmed}
                />
              </div>

              <div className={FORM.actions}>
                <Button
                  type="button"
                  onClick={handleCreateSetupFiles}
                  disabled={!canCreateSetupFiles || localApplySucceeded}
                  data-primary-preview-button="true"
                >
                  {loading === "apply"
                    ? guidedLocalSetupActionLoadingLabel
                    : guidedLocalSetupActionLabel}
                </Button>
              </div>
              {!canCreateSetupFiles && guidedApplyBlockedReason && !localApplySucceeded ? (
                <p className="text-sm text-muted-foreground">
                  {guidedApplyBlockedReason}
                </p>
              ) : null}
              {localApplySucceeded ? (
                <GuidedStepSuccessPanel
                  heading={
                    localSetupFilesExist
                      ? "Local setup files updated"
                      : "Local setup files created"
                  }
                  explanation="Your target repo configuration and local gitignored setup files are ready on this machine."
                  details={localApplySuccessDetails}
                  continueLabel="Continue to local readiness"
                  onContinue={onContinue ?? (() => undefined)}
                />
              ) : null}
            </SectionCard>
          );
      }
    };

    return (
      <div className={SPACING.section}>
        <div ref={guidedTopRef} />
        {renderGuidedStep()}

        {error ? (
          <SetupApplyResult success={false} message={error} />
        ) : null}
      </div>
    );
  }

  return (
    <div className={SPACING.section}>
      <SectionCard
        title="Environment (.env.local)"
        description="Edit local env keys. Existing secret values are never shown."
      >
        <EnvironmentConfigForm
          values={envValues}
          presence={presence}
          highlightDispatchRepo={highlightStaleDispatch}
          variant="advanced"
          onChange={(values) => {
            invalidatePreview();
            setEnvValues(values);
          }}
        />
      </SectionCard>

      <SectionCard
        title="Target repo config"
        description="Guided fields for .harness/config.local.json."
      >
        <TargetRepoConfigForm
          values={configValues}
          highlightStaleTarget={highlightStaleTarget}
          variant="advanced"
          onChange={(values) => {
            invalidatePreview();
            setConfigValues(values);
          }}
        />
      </SectionCard>

      <SectionCard
        title="Preview local changes"
        description="Required before apply. Secret values are redacted in previews."
      >
        <LocalWritePreview
          envPreview={previewIsCurrent ? preview?.envPreview : undefined}
          configPreview={previewIsCurrent ? preview?.configPreview : undefined}
          validationError={
            previewIsCurrent ? preview?.validationError : undefined
          }
        />
        <div className={FORM.actions}>
          <Button
            type="button"
            onClick={handlePreview}
            disabled={loading !== null}
            data-primary-preview-button="true"
          >
            {loading === "preview" ? "Generating preview…" : "Preview setup files"}
          </Button>
        </div>
        {previewDisabledReason ? (
          <p className="text-sm text-muted-foreground">{previewDisabledReason}</p>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Confirm and apply"
        description="Writes only local gitignored setup files through setup core."
      >
        <LocalWriteConfirmation
          plan={previewIsCurrent ? preview?.plan : undefined}
          confirmed={confirmed}
          disabled={!previewIsCurrent || Boolean(preview?.validationError)}
          disabledReason={confirmDisabledReason}
          onConfirmedChange={setConfirmed}
        />
        <div className={FORM.actions}>
          <Button
            type="button"
            onClick={handleApply}
            disabled={
              loading !== null ||
              !previewIsCurrent ||
              !confirmed ||
              Boolean(preview?.validationError)
            }
          >
            {loading === "apply" ? "Creating…" : "Create local setup files"}
          </Button>
        </div>
        {applyDisabledReason ? (
          <p className="text-sm text-muted-foreground">{applyDisabledReason}</p>
        ) : null}
      </SectionCard>

      {error ? (
        <SetupApplyResult success={false} message={error} />
      ) : null}
      {applySuccess !== null && !error ? (
        <SetupApplyResult
          success={applySuccess}
          message={
            applySuccess
              ? "Local setup files were written successfully."
              : "Apply failed."
          }
          summary={applySummary ?? undefined}
        />
      ) : null}
    </div>
  );
}
