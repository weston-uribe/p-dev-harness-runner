"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { VercelBridgePreview } from "@harness/setup/vercel-setup-apply";
import type { VercelBridgeApplyResult } from "@harness/setup/vercel-setup-apply";
import type { VercelSetupSummary } from "@harness/setup/vercel-setup-summary";
import type { FirstRunReadiness } from "@harness/setup/first-run-readiness";
import { validateVercelProjectName } from "@harness/setup/vercel-project-name";
import type {
  VercelBridgeOptionsResult,
  VercelBridgeProjectOption,
  VercelBridgeScopeOption,
} from "@harness/setup/vercel-bridge-options";

import { FORM, SPACING } from "@/lib/constants";
import { GUIDED_SETUP_STEP_COUNT } from "@/lib/guided-setup";
import { readSetupJsonResponse } from "@/lib/setup-json-response";
import {
  canInvalidatePreviewDuringPolling,
  isRedeployPollingActive,
  mapOrchestrationPhaseLabel,
  REDEPLOY_POLLING_LOCK_MESSAGE,
  resolveOrchestrationStatusMessage,
  shouldHideApplyButton,
  shouldShowTerminalApplyResult,
} from "@/lib/vercel-bridge-polling-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GuidedSelect } from "@/components/ui/guided-select";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/custom/section-card";
import { RemoteActionConfirmation } from "@/components/custom/remote-action-confirmation";
import { SetupApplyResult } from "@/components/custom/setup-apply-result";
import { VercelBridgeOrchestrationStatus } from "@/components/custom/vercel-bridge-orchestration-status";
import { GuidedOperationPanel, buildGuidedOperationPhases } from "@/components/custom/guided-operation-panel";
import { GuidedStepSuccessPanel } from "@/components/custom/guided-step-success-panel";

const VERCEL_OPERATION_PHASES = [
  "Validating Vercel selection",
  "Creating or connecting project",
  "Deploying automation bridge",
  "Writing environment variables",
  "Configuring Linear webhook",
  "Verifying signed webhook",
] as const;

function resolveVercelOperationActiveIndex(input: {
  loading: "preview" | "apply" | "poll" | "refresh" | null;
  applyResult?: VercelBridgeApplyResult | null;
  orchestrationPhase?: string;
}): number {
  if (input.loading === "apply") {
    return 0;
  }
  const stepPhase = input.applyResult?.orchestrationSteps?.find(
    (step) => step.status === "active",
  )?.phase;
  switch (stepPhase) {
    case "deploying_bridge":
      return 2;
    case "writing_env_vars":
      return 3;
    case "verifying_webhook":
      return 5;
    default:
      break;
  }
  switch (input.applyResult?.orchestrationPhase ?? input.orchestrationPhase) {
    case "triggered":
    case "building":
    case "waiting_for_ready":
      return 2;
    case "verifying":
    case "retry_wait":
      return 5;
    case "verified":
      return VERCEL_OPERATION_PHASES.length;
    default:
      return 0;
  }
}

interface GuidedVercelBridgeCardProps {
  readiness: FirstRunReadiness;
  initialSummary: VercelSetupSummary;
  onSummaryUpdated?: (summary: VercelSetupSummary) => void;
  onUiStateChange?: (state: { vercelPreviewStale: boolean }) => void;
  onContinue: () => void;
  onStepCompleted?: () => void;
}

function buildVercelApplyResultMessage(apply: VercelBridgeApplyResult): string {
  if (apply.status === "deployment-required") {
    return `${apply.deploymentRequired?.message ?? "Deployment required."} ${apply.deploymentRequired?.nextSteps.join(" ") ?? ""}`;
  }

  if (apply.setupBlocked) {
    return [apply.setupBlocked.message, ...apply.setupBlocked.nextSteps].join(" ");
  }

  if (apply.verified && apply.signedProbeVerified) {
    return "PDev automation bridge verified.";
  }

  const parts = [
    `Vercel team: ${apply.team?.outcome ?? "unchanged"} ${apply.team?.name ?? ""}.`,
    `Vercel project: ${apply.project?.outcome ?? "unchanged"} ${apply.project?.name ?? apply.projectName}.`,
    `Env vars written: ${apply.writtenEnvKeys.join(", ") || "none"}.`,
    `Linear webhook setup: ${apply.linearWebhookSetup.mode}.`,
    `Signed probe: ${apply.signedProbeVerified ? "passed" : "failed"}${apply.signedProbeReason ? ` (${apply.signedProbeReason})` : ""}.`,
  ];

  if (apply.productionRedeployTriggered) {
    parts.push(
      `Production redeploy: ${apply.productionRedeployStatus ?? "unknown"}.`,
    );
  }

  return parts.join(" ");
}

function isTerminalRedeployApply(
  apply: VercelBridgeApplyResult,
  summary: VercelSetupSummary,
): boolean {
  if (apply.verified && apply.signedProbeVerified) {
    return true;
  }
  if (apply.setupPending || summary.orchestration?.active) {
    return false;
  }
  return Boolean(
    apply.setupBlocked ||
      apply.productionRedeployStatus === "failed" ||
      apply.productionRedeployStatus === "timeout" ||
      apply.productionRedeployStatus === "no_source_deployment" ||
      summary.orchestration?.terminal,
  );
}

function resumeOrchestrationFromSummary(summary: VercelSetupSummary): {
  setupPending: boolean;
  pollActionId: string | null;
  verifiedSuccess: boolean;
} {
  const orchestration = summary.orchestration;
  if (!orchestration) {
    return {
      setupPending: false,
      pollActionId: null,
      verifiedSuccess: summary.readiness.ready,
    };
  }

  if (orchestration.verified || summary.readiness.ready) {
    return {
      setupPending: false,
      pollActionId: null,
      verifiedSuccess: true,
    };
  }

  if (orchestration.active) {
    return {
      setupPending: true,
      pollActionId: orchestration.pollActionId ?? null,
      verifiedSuccess: false,
    };
  }

  return {
    setupPending: false,
    pollActionId: null,
    verifiedSuccess: false,
  };
}

export function GuidedVercelBridgeCard({
  readiness,
  initialSummary,
  onSummaryUpdated,
  onUiStateChange,
  onContinue,
  onStepCompleted,
}: GuidedVercelBridgeCardProps) {
  const initialResume = resumeOrchestrationFromSummary(initialSummary);
  const [summary, setSummary] = useState(initialSummary);
  const [scopes, setScopes] = useState<VercelBridgeScopeOption[]>([]);
  const [projects, setProjects] = useState<VercelBridgeProjectOption[]>([]);
  const [capabilities, setCapabilities] = useState({
    teamCreate: true,
    projectCreate: true,
  });
  const [githubDispatchEligible, setGithubDispatchEligible] = useState(true);
  const [githubDispatchMessage, setGithubDispatchMessage] = useState<string | null>(
    null,
  );
  const [teamMode, setTeamMode] = useState<"existing" | "create">("existing");
  const [teamId, setTeamId] = useState(summary.controlPlane?.vercel?.teamId ?? "");
  const [teamName, setTeamName] = useState("");
  const [teamSlug, setTeamSlug] = useState("");
  const [projectMode, setProjectMode] = useState<"existing" | "create">("existing");
  const [projectId, setProjectId] = useState(
    summary.controlPlane?.vercel?.projectId ?? "",
  );
  const [projectName, setProjectName] = useState("");
  const [harnessTeamKey, setHarnessTeamKey] = useState(
    summary.linearTeamKey ?? "",
  );
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [preview, setPreview] = useState<VercelBridgePreview | null>(null);
  const [previewGenerated, setPreviewGenerated] = useState(false);
  const [previewDisclosed, setPreviewDisclosed] = useState(false);
  const [
    allowExistingProjectBridgeInstall,
    setAllowExistingProjectBridgeInstall,
  ] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState<
    "preview" | "apply" | "poll" | "refresh" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<VercelBridgeApplyResult | null>(
    null,
  );
  const [pollActionId, setPollActionId] = useState<string | null>(
    initialResume.pollActionId,
  );
  const [setupPending, setSetupPending] = useState(initialResume.setupPending);
  const [verifiedSuccess, setVerifiedSuccess] = useState(
    initialResume.verifiedSuccess,
  );
  const [manualCopySecret, setManualCopySecret] = useState<string | null>(null);
  const [manualCopyAcknowledged, setManualCopyAcknowledged] = useState(false);

  const redeployPollingActive = isRedeployPollingActive({
    setupPending,
    pollActionId,
    orchestration: summary.orchestration,
  });
  const controlsLocked = redeployPollingActive || loading !== null;
  const orchestrationStatusMessage = resolveOrchestrationStatusMessage({
    loading,
    applyResult,
    orchestration: summary.orchestration,
  });
  const showTerminalApplyResult = shouldShowTerminalApplyResult({
    applyResult,
    orchestration: summary.orchestration,
    redeployPollingActive,
  });
  const hideApplyButton = shouldHideApplyButton({
    verifiedSuccess,
    redeployPollingActive,
  });
  const projectNameValidation = useMemo(
    () =>
      projectMode === "create"
        ? validateVercelProjectName(projectName)
        : { valid: true, normalized: projectName },
    [projectMode, projectName],
  );

  useEffect(() => {
    setSummary(initialSummary);
    if (initialSummary.linearTeamKey) {
      setHarnessTeamKey(initialSummary.linearTeamKey);
    }
    const resumed = resumeOrchestrationFromSummary(initialSummary);
    setSetupPending(resumed.setupPending);
    setPollActionId(resumed.pollActionId);
    setVerifiedSuccess(resumed.verifiedSuccess);
  }, [initialSummary]);

  const previewIsCurrent = preview !== null && previewGenerated;

  useEffect(() => {
    onUiStateChange?.({
      vercelPreviewStale: preview !== null && !previewIsCurrent,
    });
  }, [onUiStateChange, preview, previewIsCurrent]);

  const loadOptions = useCallback(async (scopeId?: string) => {
    setOptionsLoading(true);
    setOptionsError(null);
    try {
      const query =
        scopeId !== undefined ? `?teamId=${encodeURIComponent(scopeId)}` : "";
      const response = await fetch(`/api/setup/vercel-bridge-options${query}`);
      const data = (await response.json()) as VercelBridgeOptionsResult & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? data.loadError ?? "Failed to load Vercel options");
      }
      setScopes(data.scopes ?? []);
      setProjects(data.projects ?? []);
      setCapabilities(data.capabilities ?? { teamCreate: true, projectCreate: true });
      if (data.harnessTeamKey) {
        setHarnessTeamKey(data.harnessTeamKey);
      }
      setGithubDispatchEligible(data.githubDispatch.eligible);
      setGithubDispatchMessage(
        data.githubDispatch.eligible ? null : data.githubDispatch.message,
      );
      if (!data.githubDispatch.eligible) {
        setPreview(null);
        setPreviewGenerated(false);
        setPreviewDisclosed(false);
        setConfirmed(false);
      }
      if (scopeId === undefined && data.selectedScopeId !== undefined) {
        setTeamId(data.selectedScopeId);
      }
      setProjectId((current) =>
        data.projects.some((project) => project.id === current)
          ? current
          : (data.selectedProjectId ?? ""),
      );
      if (data.loadError) {
        setOptionsError(data.loadError);
      }
    } catch (loadError) {
      setOptionsError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load Vercel settings options",
      );
    } finally {
      setOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (summary.vercelTokenConfigured) {
      void loadOptions();
    }
  }, [loadOptions, summary.vercelTokenConfigured]);

  const refreshSummary = useCallback(async () => {
    setLoading("refresh");
    try {
      const response = await fetch("/api/setup/vercel-summary");
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Vercel summary refresh failed");
      }
      const nextSummary = data as VercelSetupSummary;
      setSummary(nextSummary);
      onSummaryUpdated?.(nextSummary);
      const resumed = resumeOrchestrationFromSummary(nextSummary);
      setSetupPending(resumed.setupPending);
      setPollActionId(resumed.pollActionId);
      setVerifiedSuccess(resumed.verifiedSuccess);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Vercel summary refresh failed",
      );
    } finally {
      setLoading(null);
    }
  }, [onSummaryUpdated]);

  const invalidatePreview = useCallback(
    (options?: { force?: boolean }) => {
      if (!canInvalidatePreviewDuringPolling(redeployPollingActive, options)) {
        return;
      }
      setPreview(null);
      setPreviewGenerated(false);
      setPreviewDisclosed(false);
      setVerifiedSuccess(false);
      setApplyResult(null);
      setPollActionId(null);
      setSetupPending(false);
      setManualCopySecret(null);
      setManualCopyAcknowledged(false);
    },
    [redeployPollingActive],
  );

  const buildPlanPayload = useCallback(
    () => ({
      team: {
        mode: teamMode,
        teamId: teamMode === "existing" ? teamId : undefined,
        teamName: teamMode === "create" ? teamName || undefined : undefined,
        teamSlug: teamMode === "create" ? teamSlug || undefined : undefined,
      },
      project: {
        mode: projectMode,
        projectId: projectMode === "existing" ? projectId || undefined : undefined,
        projectName: projectMode === "create" ? projectName || undefined : undefined,
      },
      allowExistingProjectBridgeInstall:
        projectMode === "existing" ? allowExistingProjectBridgeInstall : undefined,
      teamId: teamMode === "existing" ? teamId || undefined : undefined,
      projectId: projectMode === "existing" ? projectId || undefined : undefined,
      projectName: projectMode === "create" ? projectName || undefined : undefined,
      linearTeamId: summary.controlPlane?.linear?.teamId,
      envInput: {
        HARNESS_TEAM_KEY: harnessTeamKey || undefined,
      },
    }),
    [
      allowExistingProjectBridgeInstall,
      harnessTeamKey,
      projectId,
      projectMode,
      projectName,
      summary.controlPlane?.linear?.teamId,
      teamId,
      teamMode,
      teamName,
      teamSlug,
    ],
  );

  const applyVercelBridgeResponse = useCallback(
    async (apply: VercelBridgeApplyResult, nextSummary: VercelSetupSummary) => {
      setApplyResult(apply);
      if (apply.status === "deployment-required") {
        setError(
          apply.deploymentRequired?.message ??
            "Deployment required before applying settings.",
        );
        setVerifiedSuccess(false);
        setSetupPending(false);
        setPollActionId(null);
        void loadOptions(teamMode === "existing" ? teamId : undefined);
        setPreview(null);
        setPreviewGenerated(false);
        setPreviewDisclosed(false);
        setConfirmed(false);
        return;
      }

      setSummary(nextSummary);
      onSummaryUpdated?.(nextSummary);
      const signedProbeSuccess = apply.verified && apply.signedProbeVerified;
      setVerifiedSuccess(apply.verified);
      setSetupPending(Boolean(apply.setupPending || nextSummary.orchestration?.active));
      setPollActionId(
        apply.pollActionId ?? nextSummary.orchestration?.pollActionId ?? null,
      );

      if (apply.linearWebhookSetup.manualCopySecret) {
        setManualCopySecret(apply.linearWebhookSetup.manualCopySecret);
        setManualCopyAcknowledged(false);
      } else {
        setManualCopySecret(null);
      }
      setPreview(null);
      setPreviewGenerated(false);
      setPreviewDisclosed(false);
      setConfirmed(false);
      if (signedProbeSuccess) {
        onStepCompleted?.();
      }
      void loadOptions(teamMode === "existing" ? teamId : undefined);
    },
    [loadOptions, onStepCompleted, onSummaryUpdated, teamId, teamMode],
  );

  const pollRedeployStatus = useCallback(async () => {
    if (!pollActionId) {
      return;
    }

    setLoading("poll");
    setError(null);
    try {
      const response = await fetch("/api/setup/vercel-bridge-redeploy-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: pollActionId,
        }),
      });
      const data = await readSetupJsonResponse<{
        apply: VercelBridgeApplyResult;
        summary: VercelSetupSummary;
        error?: string;
      }>(response, "POST /api/setup/vercel-bridge-redeploy-status");

      if (!response.ok) {
        throw new Error(data.error ?? "Redeploy status check failed");
      }

      const apply = data.apply;
      await applyVercelBridgeResponse(apply, data.summary);
      if (isTerminalRedeployApply(apply, data.summary)) {
        setSetupPending(false);
        setPollActionId(null);
      }
    } catch (pollError) {
      setError(
        pollError instanceof Error
          ? pollError.message
          : "Redeploy status check failed",
      );
      if (!summary.orchestration?.active) {
        setSetupPending(false);
      }
    } finally {
      setLoading(null);
    }
  }, [applyVercelBridgeResponse, pollActionId, summary.orchestration?.active]);

  useEffect(() => {
    if (!setupPending || !pollActionId) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void pollRedeployStatus();
    }, 5000);

    void pollRedeployStatus();

    return () => {
      window.clearInterval(intervalId);
    };
  }, [pollActionId, pollRedeployStatus, setupPending]);

  const runPreview = useCallback(async () => {
    const response = await fetch("/api/setup/preview-vercel-bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPlanPayload()),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Preview failed");
    }
    const nextPreview = data as VercelBridgePreview;
    setPreview(nextPreview);
    setPreviewGenerated(true);
    return nextPreview;
  }, [buildPlanPayload]);

  const handlePreview = useCallback(async () => {
    if (redeployPollingActive) {
      return;
    }
    setLoading("preview");
    setError(null);
    setPreviewError(null);
    invalidatePreview();
    setConfirmed(false);
    try {
      await runPreview();
      setPreviewDisclosed(true);
    } catch (nextPreviewError) {
      setPreview(null);
      setPreviewGenerated(false);
      setPreviewDisclosed(true);
      setPreviewError(
        nextPreviewError instanceof Error
          ? nextPreviewError.message
          : "Preview failed",
      );
    } finally {
      setLoading(null);
    }
  }, [invalidatePreview, redeployPollingActive, runPreview]);

  const handleApply = async () => {
    if (redeployPollingActive) {
      return;
    }
    if (!confirmed) {
      return;
    }
    if (!githubDispatchEligible) {
      setError(
        githubDispatchMessage ??
          "Saved GITHUB_TOKEN cannot dispatch to the harness repository. Update Step 1 before applying.",
      );
      return;
    }
    if (projectMode === "create" && !projectNameValidation.valid) {
      setError(projectNameValidation.error ?? "Vercel project name is invalid.");
      return;
    }

    setLoading("apply");
    setError(null);
    invalidatePreview();
    try {
      const currentPreview =
        previewIsCurrent && preview ? preview : await runPreview();
      if (currentPreview.validationError) {
        throw new Error(currentPreview.validationError);
      }

      const response = await fetch("/api/setup/apply-vercel-bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: buildPlanPayload(),
          confirmed: true,
          fingerprint: currentPreview.fingerprint,
        }),
      });
      const data = await readSetupJsonResponse<{
        apply: VercelBridgeApplyResult;
        summary: VercelSetupSummary;
        error?: string;
      }>(response, "POST /api/setup/apply-vercel-bridge");
      if (!response.ok) {
        throw new Error(data.error ?? "Apply failed");
      }

      await applyVercelBridgeResponse(data.apply, data.summary);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Apply failed");
    } finally {
      setLoading(null);
    }
  };

  const formComplete =
    teamMode === "existing"
      ? Boolean(harnessTeamKey) &&
        (projectMode === "existing"
          ? Boolean(projectId)
          : Boolean(projectName) && projectNameValidation.valid)
      : Boolean(teamSlug && harnessTeamKey) &&
        (projectMode === "existing"
          ? Boolean(projectId)
          : Boolean(projectName) && projectNameValidation.valid);
  const stepPrerequisitesMet = githubDispatchEligible;

  const canContinue =
    (verifiedSuccess && applyResult?.signedProbeVerified === true) ||
    summary.readiness.ready;
  const operationActive = loading === "apply" || redeployPollingActive;
  const operationActiveIndex = resolveVercelOperationActiveIndex({
    loading,
    applyResult,
    orchestrationPhase: summary.orchestration?.phase,
  });
  const operationSupportingText =
    orchestrationStatusMessage ?? VERCEL_OPERATION_PHASES[operationActiveIndex];

  return (
    <SectionCard
      title={`Step 3 of ${GUIDED_SETUP_STEP_COUNT} · Configure PDev automation bridge`}
      description="Choose the Vercel team and project that hosts the PDev automation bridge."
    >
      <div className={SPACING.stackSm}>
        {!summary.vercelTokenConfigured ? (
          <p className="text-sm text-muted-foreground">
            Add VERCEL_TOKEN in Step 1 before configuring the PDev automation bridge.
          </p>
        ) : (
          <>
            {redeployPollingActive ? (
              <p className="text-sm text-muted-foreground">
                {REDEPLOY_POLLING_LOCK_MESSAGE}
              </p>
            ) : null}
            {!stepPrerequisitesMet && githubDispatchMessage ? (
              <p className="text-sm text-destructive">{githubDispatchMessage}</p>
            ) : null}
            {orchestrationStatusMessage && !operationActive ? (
              <VercelBridgeOrchestrationStatus
                message={orchestrationStatusMessage}
                phaseLabel={mapOrchestrationPhaseLabel(
                  applyResult?.orchestrationPhase ?? summary.orchestration?.phase,
                )}
              />
            ) : null}
            {stepPrerequisitesMet ? (
              <>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="vercel-team-mode">Vercel team name</Label>
                {capabilities.teamCreate ? (
                  <GuidedSelect
                  id="vercel-team-mode"
                                        value={teamMode}
                    onChange={(event) => {
                      if (redeployPollingActive) {
                        return;
                      }
                      setTeamMode(event.target.value as "existing" | "create");
                      invalidatePreview();
                    }}
                    disabled={controlsLocked}
                  >
                    <option value="existing">Use existing team</option>
                    <option value="create">Create new team</option>
                  </GuidedSelect>
                ) : null}
                {teamMode === "existing" ? (
                  <GuidedSelect
                  id="vercel-team-name"
                                        value={teamId}
                    onChange={(event) => {
                      if (redeployPollingActive) {
                        return;
                      }
                      setTeamId(event.target.value);
                      setProjectId("");
                      invalidatePreview();
                      void loadOptions(event.target.value);
                    }}
                    disabled={controlsLocked || optionsLoading}
                  >
                    {scopes.map((scope) => (
                      <option key={scope.id || "personal"} value={scope.id}>
                        {scope.label}
                      </option>
                    ))}
                  </GuidedSelect>
                ) : (
                  <div className="space-y-2">
                    <Input
                      placeholder="Team name"
                      value={teamName}
                      onChange={(event) => {
                        if (redeployPollingActive) {
                          return;
                        }
                        setTeamName(event.target.value);
                        invalidatePreview();
                      }}
                      disabled={controlsLocked}
                    />
                    <Input
                      placeholder="Team slug"
                      value={teamSlug}
                      onChange={(event) => {
                        if (redeployPollingActive) {
                          return;
                        }
                        setTeamSlug(event.target.value);
                        invalidatePreview();
                      }}
                      disabled={controlsLocked}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="vercel-project-mode">Vercel project</Label>
                {capabilities.projectCreate ? (
                  <GuidedSelect
                  id="vercel-project-mode"
                                        value={projectMode}
                    onChange={(event) => {
                      if (redeployPollingActive) {
                        return;
                      }
                      setProjectMode(event.target.value as "existing" | "create");
                      setAllowExistingProjectBridgeInstall(false);
                      invalidatePreview();
                    }}
                    disabled={controlsLocked}
                  >
                    <option value="existing">Use existing project</option>
                    <option value="create">Create new project</option>
                  </GuidedSelect>
                ) : null}
                {projectMode === "existing" ? (
                  <GuidedSelect
                  id="vercel-project-id"
                                        value={projectId}
                    onChange={(event) => {
                      if (redeployPollingActive) {
                        return;
                      }
                      setProjectId(event.target.value);
                      setAllowExistingProjectBridgeInstall(false);
                      invalidatePreview();
                    }}
                    disabled={controlsLocked || optionsLoading || projects.length === 0}
                  >
                    <option value="">Select a project…</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </GuidedSelect>
                ) : (
                  <Input
                    placeholder="Project name"
                    value={projectName}
                    onChange={(event) => {
                      if (redeployPollingActive) {
                        return;
                      }
                      setProjectName(event.target.value);
                      invalidatePreview();
                    }}
                    disabled={controlsLocked}
                  />
                )}
                {projectMode === "create" && projectNameValidation.error ? (
                  <p className="text-sm text-destructive">
                    {projectNameValidation.error}
                  </p>
                ) : null}
                {projectMode === "existing" && projectId ? (
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-muted/10 p-3 text-sm has-[:disabled]:cursor-not-allowed">
                    <input
                      type="checkbox"
                      className="mt-0.5 cursor-pointer disabled:cursor-not-allowed"
                      checked={allowExistingProjectBridgeInstall}
                      disabled={controlsLocked}
                      onChange={(event) => {
                        const nextChecked = event.target.checked;
                        setAllowExistingProjectBridgeInstall(nextChecked);
                        setPreview(null);
                        setPreviewGenerated(false);
                        setPreviewDisclosed(false);
                        setConfirmed(false);
                      }}
                    />
                    <span className="text-muted-foreground">
                      Allow PDev to install the automation bridge into this
                      existing project if it is not already marked as
                      PDev-managed.
                    </span>
                  </label>
                ) : null}
              </div>
            </div>

            {optionsLoading ? (
              <p className="text-sm text-muted-foreground">
                Loading Vercel teams and projects…
              </p>
            ) : null}
            {optionsError ? (
              <p className="text-sm text-destructive">{optionsError}</p>
            ) : null}

            <div className={FORM.actions}>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handlePreview()}
                disabled={controlsLocked || !formComplete}
              >
                {loading === "preview" ? "Previewing…" : "Preview PDev automation bridge"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void refreshSummary()}
                disabled={controlsLocked}
              >
                Refresh
              </Button>
            </div>

            {previewDisclosed && previewIsCurrent && preview ? (
              <div className="rounded-md border border-border bg-muted/10 p-3 text-sm space-y-2">
                <p>Webhook URL: {preview.webhookUrl ?? "unknown"}</p>
                <p>
                  Endpoint reachable:{" "}
                  {preview.endpointReachable ? "yes" : "no"}
                </p>
                <p>
                  GitHub dispatch source: {preview.githubDispatchSource ?? "unknown"}
                </p>
                <p>
                  Linear webhook secret mode:{" "}
                  {preview.linearWebhookSecretMode ?? "unknown"}
                </p>
                <p className="text-muted-foreground">
                  Preview does not run signed verification. Apply writes the
                  webhook secret and runs a signed production probe after env
                  setup.
                </p>
                <p>
                  Signed probe verified:{" "}
                  {preview.signedProbeVerified ? "yes" : "no (runs on apply)"}
                </p>
                {preview.deploymentStatus !== "ready" ? (
                  <p className="text-amber-700 dark:text-amber-400">
                    Deployment status: {preview.deploymentStatus}
                  </p>
                ) : null}
                {preview.manualSteps.length > 0 ? (
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {preview.manualSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                ) : null}
                {previewError ? (
                  <p className="text-destructive">{previewError}</p>
                ) : null}
              </div>
            ) : null}

            {loading !== "apply" && !operationActive && !verifiedSuccess ? (
              <RemoteActionConfirmation
                scope="vercel-bridge-write"
                variant="guided"
                confirmed={confirmed}
                disabled={controlsLocked || !formComplete}
                disabledReason={
                  redeployPollingActive
                    ? REDEPLOY_POLLING_LOCK_MESSAGE
                    : !formComplete
                    ? "Select or enter the Vercel team and project before confirming."
                    : teamMode === "create"
                      ? "This will create provider resources in Vercel when you apply."
                      : undefined
                }
                onConfirmedChange={(nextConfirmed) => {
                  if (redeployPollingActive) {
                    return;
                  }
                  setConfirmed(nextConfirmed);
                }}
              />
            ) : null}

            {operationActive ? (
              <GuidedOperationPanel
                phases={buildGuidedOperationPhases({
                  labels: [...VERCEL_OPERATION_PHASES],
                  activeIndex: operationActiveIndex,
                })}
                supportingText={operationSupportingText}
              />
            ) : null}

            {!hideApplyButton && !operationActive ? (
              <div className={FORM.actions}>
                <Button
                  type="button"
                  onClick={() => void handleApply()}
                  disabled={
                    controlsLocked ||
                    !confirmed ||
                    !formComplete ||
                    Boolean(preview?.validationError)
                  }
                >
                  Apply PDev automation bridge
                </Button>
              </div>
            ) : null}

            {error ? <SetupApplyResult success={false} message={error} /> : null}
            {showTerminalApplyResult &&
            applyResult &&
            !(applyResult.verified && applyResult.signedProbeVerified) ? (
              <SetupApplyResult
                success={applyResult.verified}
                message={buildVercelApplyResultMessage(applyResult)}
              />
            ) : null}

            {verifiedSuccess && applyResult?.signedProbeVerified ? (
              <GuidedStepSuccessPanel
                heading="PDev automation bridge verified"
                explanation="The Vercel bridge, environment variables, Linear webhook, and signed production probe are ready."
                details={[
                  `Project: ${applyResult.project?.name ?? applyResult.projectName}`,
                  `Env vars written: ${applyResult.writtenEnvKeys.join(", ") || "none"}`,
                  `Linear webhook: ${applyResult.linearWebhookSetup.mode}`,
                ]}
                continueLabel="Continue to Step 4"
                onContinue={onContinue}
              />
            ) : null}

            {manualCopySecret ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm space-y-2">
                <p className="font-medium">Manual Linear webhook secret (one-time)</p>
                <p className="text-muted-foreground">
                  Copy this secret into the Linear webhook signing secret field.
                  Manual acknowledgement does not verify the bridge; signed
                  delivery verification must pass after you apply again.
                </p>
                <Input readOnly value={manualCopySecret} />
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={manualCopyAcknowledged}
                    onChange={(event) =>
                      setManualCopyAcknowledged(event.target.checked)
                    }
                  />
                  I copied the webhook secret into Linear.
                </label>
                {applyResult?.linearWebhookSetup.manualSteps.length ? (
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {applyResult.linearWebhookSetup.manualSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {canContinue && !verifiedSuccess ? (
              <Button type="button" onClick={onContinue}>
                Continue to target repo setup
              </Button>
            ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </SectionCard>
  );
}
