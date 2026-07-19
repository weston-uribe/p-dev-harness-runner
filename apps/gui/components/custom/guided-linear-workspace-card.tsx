"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LinearSetupApplyResult } from "@harness/setup/linear-setup-apply";
import type { LinearWorkspaceApplyResult } from "@harness/setup/linear-workspace-apply";
import type { LinearSetupPreview } from "@harness/setup/linear-setup-apply";
import type { LinearSetupSummary } from "@harness/setup/linear-setup-summary";
import type { LinearWorkspacePreview } from "@harness/setup/linear-workspace-plan";
import { formatLinearCategoryLabel } from "@harness/setup/linear-category-labels";
import type {
  LinearProjectSummary,
  LinearTeamSummary,
} from "@harness/setup/linear-setup-client";
import type { FirstRunReadiness } from "@harness/setup/first-run-readiness";
import type { ResolvedLinearAssociation } from "@harness/config/resolve-linear-workspace";
import {
  formatLinearTeamLabel,
  linearAssociationKey,
} from "@harness/config/resolve-linear-workspace";

import { FORM, SPACING } from "@/lib/constants";
import { GUIDED_SETUP_STEP_COUNT } from "@/lib/guided-setup";
import {
  addProjectsToDraft,
  buildConfiguredAssociationKeys,
  foldResolvedAssociationIntoDraft,
  groupAssociationsByTeam,
  removeDraftAssociation,
  removeDraftTeam,
} from "@/lib/linear-association-draft";
import {
  applyLinearSetup,
  applyLinearWorkspace,
  previewLinearSetup,
  previewLinearWorkspace,
} from "@/lib/settings/settings-setup-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GuidedSelect } from "@/components/ui/guided-select";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/custom/section-card";
import { StatusBadge } from "@/components/custom/status-badge";
import { RemoteActionConfirmation } from "@/components/custom/remote-action-confirmation";
import { SetupApplyResult } from "@/components/custom/setup-apply-result";
import {
  GuidedOperationPanel,
  buildGuidedOperationPhases,
} from "@/components/custom/guided-operation-panel";
import { GuidedStepSuccessPanel } from "@/components/custom/guided-step-success-panel";

const LINEAR_OPERATION_PHASES = [
  "Validating Linear plan",
  "Creating or selecting team",
  "Creating or selecting project",
  "Configuring workflow statuses",
  "Verifying Linear workspace",
] as const;

const LINEAR_PHASE_INDEX_BY_LABEL: Map<string, number> = new Map(
  LINEAR_OPERATION_PHASES.map((label, index) => [label, index]),
);

type RepoOption = { id: string; targetRepo: string };

type LinearWorkspaceEditorBootstrap = {
  associations: ResolvedLinearAssociation[];
  repos: RepoOption[];
  expectedCommittedFingerprint: string;
  workspaceId: string;
  workspaceName: string;
};

type PendingLinearCreateEntry = {
  id: string;
  workspaceId: string;
  teamMode: "existing" | "create";
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  projectMode: "existing" | "create";
  projectId?: string;
  projectName?: string;
  targetRepo: string;
  repoConfigId: string;
};

interface GuidedLinearWorkspaceCardProps {
  readiness: FirstRunReadiness;
  initialSummary: LinearSetupSummary;
  linearApiKeyConfigured?: boolean;
  availableRepos?: RepoOption[];
  onSummaryUpdated?: (summary: LinearSetupSummary) => void;
  onUiStateChange?: (state: { linearPreviewStale: boolean }) => void;
  onContinue: () => void;
  onStepCompleted?: () => void;
}

function mergeRepoOptions(...sources: Array<RepoOption[] | undefined>): RepoOption[] {
  const merged = new Map<string, RepoOption>();
  for (const source of sources) {
    for (const repo of source ?? []) {
      if (!repo.id.trim() || !repo.targetRepo.trim()) {
        continue;
      }
      merged.set(repo.id, repo);
    }
  }
  return [...merged.values()];
}

function formatWorkspacePreviewSummary(preview: LinearWorkspacePreview): string {
  const lines = [
    `Teams to add: ${preview.impactSummary.teamsToAdd.join(", ") || "none"}`,
    `Projects to add: ${preview.impactSummary.projectsToAdd.join(", ") || "none"}`,
    `Teams to repair: ${preview.impactSummary.teamsToRepair.join(", ") || "none"}`,
    `Projects to detach: ${preview.impactSummary.projectsToDetach.join(", ") || "none"}`,
    ...preview.impactSummary.explicitNonActions,
  ];
  return lines.join("\n");
}

function describePendingCreate(entry: PendingLinearCreateEntry): string {
  const teamLabel =
    entry.teamMode === "create"
      ? formatLinearTeamLabel({
          teamName: entry.teamName,
          teamKey: entry.teamKey ?? "key",
        })
      : formatLinearTeamLabel({
          teamName: entry.teamName,
          teamKey: entry.teamKey ?? entry.teamId ?? "Team",
        });
  const projectLabel =
    entry.projectMode === "create"
      ? entry.projectName ?? "New project"
      : entry.projectName ?? entry.projectId ?? "Project";
  return `${teamLabel} · ${projectLabel}`;
}

export function GuidedLinearWorkspaceCard({
  readiness,
  initialSummary,
  linearApiKeyConfigured,
  availableRepos,
  onSummaryUpdated,
  onUiStateChange,
  onContinue,
  onStepCompleted,
}: GuidedLinearWorkspaceCardProps) {
  const [summary, setSummary] = useState(initialSummary);
  const [bootstrap, setBootstrap] = useState<LinearWorkspaceEditorBootstrap | null>(
    null,
  );
  const [draftAssociations, setDraftAssociations] = useState<
    ResolvedLinearAssociation[]
  >([]);
  const [pendingCreates, setPendingCreates] = useState<PendingLinearCreateEntry[]>(
    [],
  );
  const [teamMode, setTeamMode] = useState<"existing" | "create">("existing");
  const [teamId, setTeamId] = useState(summary.controlPlane?.linear?.teamId ?? "");
  const [teamKey, setTeamKey] = useState(summary.controlPlane?.linear?.teamKey ?? "");
  const [teamName, setTeamName] = useState(summary.controlPlane?.linear?.teamName ?? "");
  const [projectMode, setProjectMode] = useState<"existing" | "create">("existing");
  const [projectId, setProjectId] = useState(
    summary.controlPlane?.linear?.projectId ?? "",
  );
  const [projectName, setProjectName] = useState(
    summary.controlPlane?.linear?.projectName ?? "",
  );
  const [addProjectIds, setAddProjectIds] = useState<string[]>([]);
  const [addRepoId, setAddRepoId] = useState("");
  const [teams, setTeams] = useState<LinearTeamSummary[]>([]);
  const [projects, setProjects] = useState<LinearProjectSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("Linear workspace");
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [setupPreview, setSetupPreview] = useState<LinearSetupPreview | null>(null);
  const [workspacePreview, setWorkspacePreview] =
    useState<LinearWorkspacePreview | null>(null);
  const [previewGenerated, setPreviewGenerated] = useState(false);
  const [previewDisclosed, setPreviewDisclosed] = useState(false);
  const [previewMode, setPreviewMode] = useState<"setup" | "workspace">("setup");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState<"preview" | "apply" | "refresh" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<
    LinearSetupApplyResult | LinearWorkspaceApplyResult | null
  >(null);
  const [verifiedSuccess, setVerifiedSuccess] = useState(false);
  const [operationActiveIndex, setOperationActiveIndex] = useState(0);
  const [operationSupportingText, setOperationSupportingText] = useState<string | null>(
    null,
  );
  const applyInFlightRef = useRef(false);

  useEffect(() => {
    setSummary(initialSummary);
  }, [initialSummary]);

  const repoOptions = useMemo(
    () => mergeRepoOptions(bootstrap?.repos, availableRepos),
    [availableRepos, bootstrap?.repos],
  );

  useEffect(() => {
    if (!addRepoId && repoOptions[0]?.id) {
      setAddRepoId(repoOptions[0].id);
    }
  }, [addRepoId, repoOptions]);

  const selectedRepo =
    repoOptions.find((repo) => repo.id === addRepoId) ?? repoOptions[0];
  const targetRepo = selectedRepo?.targetRepo ?? "";
  const repoConfigId = selectedRepo?.id ?? "";
  const canAssociateWithRepo = Boolean(targetRepo && repoConfigId);
  const canUseWorkspaceApply = repoOptions.length > 0;

  const preview =
    previewMode === "workspace" ? workspacePreview : setupPreview;
  const previewIsCurrent = preview !== null && previewGenerated;

  useEffect(() => {
    onUiStateChange?.({
      linearPreviewStale: preview !== null && !previewIsCurrent,
    });
  }, [onUiStateChange, preview, previewIsCurrent]);

  const apiKeyConfigured =
    linearApiKeyConfigured ?? summary.linearApiKeyConfigured;

  const clearVerifiedSuccess = useCallback(() => {
    setVerifiedSuccess(false);
    setApplyResult(null);
  }, []);

  const invalidatePreview = useCallback(() => {
    setSetupPreview(null);
    setWorkspacePreview(null);
    setPreviewGenerated(false);
    setPreviewDisclosed(false);
    clearVerifiedSuccess();
  }, [clearVerifiedSuccess]);

  useEffect(() => {
    if (loading !== "apply") {
      return;
    }

    let cancelled = false;
    const pollProgress = async () => {
      try {
        const response = await fetch("/api/setup/linear-setup-progress");
        if (!response.ok || cancelled) {
          return;
        }
        const report = (await response.json()) as {
          uiPhaseLabel?: string | null;
          completed?: boolean;
        };
        if (!report.uiPhaseLabel) {
          return;
        }
        const index = LINEAR_PHASE_INDEX_BY_LABEL.get(report.uiPhaseLabel);
        if (index !== undefined) {
          setOperationActiveIndex(
            report.completed ? LINEAR_OPERATION_PHASES.length : index,
          );
        }
        setOperationSupportingText(report.uiPhaseLabel);
      } catch {
        // Progress polling is best-effort; apply response remains authoritative.
      }
    };

    setOperationActiveIndex(0);
    setOperationSupportingText(LINEAR_OPERATION_PHASES[0]);
    void pollProgress();
    const intervalId = window.setInterval(() => void pollProgress(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [loading]);

  const loadBootstrap = useCallback(async () => {
    setBootstrapError(null);
    try {
      const response = await fetch("/api/setup/linear-workspace-editor-state");
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to load Linear workspace state");
      }
      const nextBootstrap = data as LinearWorkspaceEditorBootstrap;
      setBootstrap(nextBootstrap);
      setDraftAssociations(nextBootstrap.associations);
      if (nextBootstrap.workspaceId) {
        setWorkspaceId(nextBootstrap.workspaceId);
      }
      if (nextBootstrap.workspaceName) {
        setWorkspaceName(nextBootstrap.workspaceName);
      }
    } catch (loadError) {
      setBootstrapError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load Linear workspace state",
      );
    }
  }, []);

  const loadWorkspaceOptions = useCallback(async () => {
    if (!apiKeyConfigured) {
      return;
    }
    setOptionsLoaded(false);
    setOptionsLoading(true);
    setOptionsError(null);
    try {
      const response = await fetch("/api/setup/linear-options");
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to load Linear teams and projects");
      }
      setTeams((data.teams ?? []) as LinearTeamSummary[]);
      setProjects((data.projects ?? []) as LinearProjectSummary[]);
      if (data.workspaceId) {
        setWorkspaceId(String(data.workspaceId));
      }
      if (data.workspaceName) {
        setWorkspaceName(String(data.workspaceName));
      }
    } catch (loadError) {
      setTeams([]);
      setProjects([]);
      setOptionsError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load Linear teams and projects",
      );
    } finally {
      setOptionsLoaded(true);
      setOptionsLoading(false);
    }
  }, [apiKeyConfigured]);

  useEffect(() => {
    void loadBootstrap();
    void loadWorkspaceOptions();
  }, [loadBootstrap, loadWorkspaceOptions]);

  const configuredKeys = useMemo(
    () => buildConfiguredAssociationKeys(draftAssociations),
    [draftAssociations],
  );

  const groupedDraft = useMemo(
    () => groupAssociationsByTeam(draftAssociations),
    [draftAssociations],
  );

  const projectOptions = useMemo(() => {
    if (teamMode === "create" || !teamId) {
      return projects;
    }
    return projects.filter(
      (project) =>
        project.teamIds.length === 0 || project.teamIds.includes(teamId),
    );
  }, [projects, teamId, teamMode]);

  const hasEligibleProjects = projectOptions.length > 0;
  const forceCreateProject = optionsLoaded && teamMode === "existing" && !hasEligibleProjects;

  useEffect(() => {
    if (!optionsLoaded || teamMode !== "existing") {
      return;
    }

    const selectedProjectStillEligible =
      projectId === "" || projectOptions.some((project) => project.id === projectId);

    if (hasEligibleProjects) {
      if (!selectedProjectStillEligible) {
        setProjectId("");
        invalidatePreview();
      }
      return;
    }

    if (projectMode !== "create") {
      setProjectMode("create");
    }
    if (projectId !== "") {
      setProjectId("");
    }
    if (projectMode !== "create" || projectId !== "") {
      invalidatePreview();
    }
  }, [
    hasEligibleProjects,
    invalidatePreview,
    optionsLoaded,
    projectId,
    projectMode,
    projectOptions,
    teamMode,
  ]);

  const refreshSummary = useCallback(async () => {
    setLoading("refresh");
    try {
      const response = await fetch("/api/setup/linear-summary");
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Linear summary refresh failed");
      }
      setSummary(data as LinearSetupSummary);
      onSummaryUpdated?.(data as LinearSetupSummary);
      await loadBootstrap();
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Linear summary refresh failed",
      );
    } finally {
      setLoading(null);
    }
  }, [loadBootstrap, onSummaryUpdated]);

  const buildSetupPlanPayload = useCallback(
    () => ({
      team: {
        mode: teamMode,
        teamId: teamMode === "existing" ? teamId : undefined,
        teamKey: teamMode === "create" ? teamKey : undefined,
        teamName: teamMode === "create" ? teamName : undefined,
      },
      project: {
        mode: projectMode,
        projectId: projectMode === "existing" ? projectId : undefined,
        projectName: projectMode === "create" ? projectName : undefined,
        targetRepo: targetRepo || undefined,
      },
    }),
    [
      projectId,
      projectMode,
      projectName,
      targetRepo,
      teamId,
      teamKey,
      teamMode,
      teamName,
    ],
  );

  const buildWorkspacePlanPayload = useCallback(
    (requestedAssociations: ResolvedLinearAssociation[]) => ({
      expectedCommittedFingerprint: bootstrap?.expectedCommittedFingerprint ?? "",
      workspaceId: workspaceId || bootstrap?.workspaceId || "",
      workspaceName: workspaceName || bootstrap?.workspaceName || "Linear workspace",
      requestedAssociations,
    }),
    [bootstrap, workspaceId, workspaceName],
  );

  const addFormComplete =
    teamMode === "existing"
      ? Boolean(teamId) &&
        (projectMode === "existing"
          ? addProjectIds.length > 0 || Boolean(projectId)
          : Boolean(projectName))
      : Boolean(teamKey && teamName) &&
        (projectMode === "existing" ? Boolean(projectId) : Boolean(projectName));

  const addCurrentSelectionToDraft = useCallback(() => {
    if (!addFormComplete) {
      return;
    }

    invalidatePreview();

    if (teamMode === "existing" && projectMode === "existing") {
      const selectedTeam = teams.find((team) => team.id === teamId);
      if (!selectedTeam) {
        return;
      }
      const projectIds =
        addProjectIds.length > 0 ? addProjectIds : projectId ? [projectId] : [];
      const selectedProjects = projectIds
        .map((id) => projects.find((project) => project.id === id))
        .filter((project): project is LinearProjectSummary => Boolean(project));

      if (canAssociateWithRepo) {
        setDraftAssociations((current) =>
          addProjectsToDraft({
            draft: current,
            workspaceId: workspaceId || bootstrap?.workspaceId || "",
            team: {
              id: selectedTeam.id,
              key: selectedTeam.key,
              name: selectedTeam.name,
            },
            projects: selectedProjects.map((project) => ({
              id: project.id,
              name: project.name,
            })),
            targetRepo,
            repoConfigId,
          }),
        );
      }
      setAddProjectIds([]);
      if (projectId) {
        setProjectId("");
      }
      return;
    }

    setPendingCreates((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        workspaceId: workspaceId || bootstrap?.workspaceId || "",
        teamMode,
        teamId: teamMode === "existing" ? teamId : undefined,
        teamKey: teamMode === "create" ? teamKey : undefined,
        teamName: teamMode === "create" ? teamName : undefined,
        projectMode,
        projectId: projectMode === "existing" ? projectId : undefined,
        projectName: projectMode === "create" ? projectName : undefined,
        targetRepo: canAssociateWithRepo ? targetRepo : "",
        repoConfigId: canAssociateWithRepo ? repoConfigId : "",
      },
    ]);
    setAddProjectIds([]);
    setProjectId("");
    setProjectName("");
  }, [
    addFormComplete,
    addProjectIds,
    bootstrap?.workspaceId,
    canAssociateWithRepo,
    invalidatePreview,
    projectId,
    projectMode,
    projectName,
    projects,
    repoConfigId,
    targetRepo,
    teamId,
    teamKey,
    teamMode,
    teamName,
    teams,
    workspaceId,
  ]);

  const resolvePendingCreates = useCallback(async () => {
    let resolvedDraft = [...draftAssociations];
    for (const entry of pendingCreates) {
      const response = await applyLinearSetup({
        plan: {
          team: {
            mode: entry.teamMode,
            teamId: entry.teamId,
            teamKey: entry.teamKey,
            teamName: entry.teamName,
          },
          project: {
            mode: entry.projectMode,
            projectId: entry.projectId,
            projectName: entry.projectName,
            targetRepo: entry.targetRepo || undefined,
          },
        },
        fingerprint: (
          await previewLinearSetup({
            team: {
              mode: entry.teamMode,
              teamId: entry.teamId,
              teamKey: entry.teamKey,
              teamName: entry.teamName,
            },
            project: {
              mode: entry.projectMode,
              projectId: entry.projectId,
              projectName: entry.projectName,
              targetRepo: entry.targetRepo || undefined,
            },
          })
        ).fingerprint,
      });
      if (!response.apply.verified) {
        throw new Error("Linear create apply finished without verification.");
      }
      const association: ResolvedLinearAssociation = {
        workspaceId: entry.workspaceId || workspaceId || bootstrap?.workspaceId || "",
        teamId: response.apply.team.id,
        teamKey: response.apply.team.key,
        teamName: response.apply.team.name,
        projectId: response.apply.project.id,
        projectName: response.apply.project.name,
        targetRepo: entry.targetRepo,
        repoConfigId: entry.repoConfigId,
      };
      resolvedDraft = foldResolvedAssociationIntoDraft({
        draft: resolvedDraft,
        association,
      });
    }
    setPendingCreates([]);
    setDraftAssociations(resolvedDraft);
    return resolvedDraft;
  }, [bootstrap?.workspaceId, draftAssociations, pendingCreates, workspaceId]);

  const runPreview = useCallback(async () => {
    if (canUseWorkspaceApply && draftAssociations.length > 0) {
      const nextPreview = await previewLinearWorkspace(
        buildWorkspacePlanPayload(draftAssociations),
      );
      if (nextPreview.validationError) {
        throw new Error(nextPreview.validationError);
      }
      setWorkspacePreview(nextPreview);
      setSetupPreview(null);
      setPreviewMode("workspace");
      setPreviewGenerated(true);
      return nextPreview;
    }

    if (draftAssociations.length === 1 && pendingCreates.length === 0) {
      const association = draftAssociations[0]!;
      const nextPreview = await previewLinearSetup({
        team: { mode: "existing", teamId: association.teamId },
        project: { mode: "existing", projectId: association.projectId },
      });
      setSetupPreview(nextPreview);
      setWorkspacePreview(null);
      setPreviewMode("setup");
      setPreviewGenerated(true);
      return nextPreview;
    }

    const pendingPreviewSource = pendingCreates[0];
    const nextPreview = pendingPreviewSource
      ? await previewLinearSetup({
          team: {
            mode: pendingPreviewSource.teamMode,
            teamId: pendingPreviewSource.teamId,
            teamKey: pendingPreviewSource.teamKey,
            teamName: pendingPreviewSource.teamName,
          },
          project: {
            mode: pendingPreviewSource.projectMode,
            projectId: pendingPreviewSource.projectId,
            projectName: pendingPreviewSource.projectName,
            targetRepo: pendingPreviewSource.targetRepo || undefined,
          },
        })
      : await previewLinearSetup(buildSetupPlanPayload());
    setSetupPreview(nextPreview);
    setWorkspacePreview(null);
    setPreviewMode("setup");
    setPreviewGenerated(true);
    return nextPreview;
  }, [
    buildSetupPlanPayload,
    buildWorkspacePlanPayload,
    canUseWorkspaceApply,
    draftAssociations,
    pendingCreates,
  ]);

  const handlePreview = useCallback(async () => {
    setLoading("preview");
    setError(null);
    setPreviewError(null);
    clearVerifiedSuccess();
    setConfirmed(false);
    try {
      await runPreview();
      setPreviewDisclosed(true);
    } catch (nextPreviewError) {
      setSetupPreview(null);
      setWorkspacePreview(null);
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
  }, [clearVerifiedSuccess, runPreview]);

  const handleApply = async () => {
    if (!confirmed || loading !== null || applyInFlightRef.current) {
      return;
    }

    applyInFlightRef.current = true;
    setLoading("apply");
    setOperationActiveIndex(0);
    setOperationSupportingText(LINEAR_OPERATION_PHASES[0]);
    setError(null);
    clearVerifiedSuccess();
    try {
      let resolvedDraft = draftAssociations;
      if (pendingCreates.length > 0) {
        resolvedDraft = await resolvePendingCreates();
      }

      if (resolvedDraft.length === 0) {
        throw new Error("Add at least one Linear team and project association before applying.");
      }

      if (canUseWorkspaceApply) {
        const currentPreview =
          previewIsCurrent && previewMode === "workspace" && workspacePreview
            ? workspacePreview
            : ((await previewLinearWorkspace(
                buildWorkspacePlanPayload(resolvedDraft),
              )) as LinearWorkspacePreview);
        if (currentPreview.validationError) {
          throw new Error(currentPreview.validationError);
        }

        const result = await applyLinearWorkspace({
          plan: buildWorkspacePlanPayload(resolvedDraft),
          fingerprint: currentPreview.fingerprint,
        });
        if (!result.apply.verified) {
          throw new Error(
            "Linear workspace apply finished, but post-apply verification did not pass.",
          );
        }

        setSummary(result.summary as LinearSetupSummary);
        onSummaryUpdated?.(result.summary as LinearSetupSummary);
        onStepCompleted?.();
        setVerifiedSuccess(true);
        setDraftAssociations(resolvedDraft);
        setApplyResult(result.apply);
      } else if (resolvedDraft.length === 1) {
        const association = resolvedDraft[0]!;
        const currentPreview =
          previewIsCurrent && previewMode === "setup" && setupPreview
            ? setupPreview
            : await previewLinearSetup({
                team: { mode: "existing", teamId: association.teamId },
                project: { mode: "existing", projectId: association.projectId },
              });
        if (currentPreview.validationError) {
          throw new Error(currentPreview.validationError);
        }

        const response = await applyLinearSetup({
          plan: {
            team: { mode: "existing", teamId: association.teamId },
            project: { mode: "existing", projectId: association.projectId },
          },
          fingerprint: currentPreview.fingerprint,
        });
        if (!response.apply.verified) {
          throw new Error(
            "Linear workspace apply finished, but post-apply verification did not pass.",
          );
        }

        setApplyResult(response.apply);
        setSummary(response.summary as LinearSetupSummary);
        onSummaryUpdated?.(response.summary as LinearSetupSummary);
        onStepCompleted?.();
        setVerifiedSuccess(true);
      } else if (pendingCreates.length > 0 || addFormComplete) {
        const currentPreview =
          previewIsCurrent && previewMode === "setup" && setupPreview
            ? setupPreview
            : await previewLinearSetup(buildSetupPlanPayload());
        if (currentPreview.validationError) {
          throw new Error(currentPreview.validationError);
        }

        const response = await applyLinearSetup({
          plan: buildSetupPlanPayload(),
          fingerprint: currentPreview.fingerprint,
        });
        if (!response.apply.verified) {
          throw new Error(
            "Linear workspace apply finished, but post-apply verification did not pass.",
          );
        }

        const association: ResolvedLinearAssociation = {
          workspaceId: workspaceId || bootstrap?.workspaceId || "",
          teamId: response.apply.team.id,
          teamKey: response.apply.team.key,
          teamName: response.apply.team.name,
          projectId: response.apply.project.id,
          projectName: response.apply.project.name,
          targetRepo,
          repoConfigId,
        };
        const nextDraft = foldResolvedAssociationIntoDraft({
          draft: resolvedDraft,
          association,
        });
        setDraftAssociations(nextDraft);
        setApplyResult(response.apply);
        setSummary(response.summary as LinearSetupSummary);
        onSummaryUpdated?.(response.summary as LinearSetupSummary);
        onStepCompleted?.();
        setVerifiedSuccess(true);
      } else {
        throw new Error(
          "Configure at least one target repository before applying multiple Linear associations.",
        );
      }

      setSetupPreview(null);
      setWorkspacePreview(null);
      setPreviewGenerated(false);
      setPreviewDisclosed(false);
      setConfirmed(false);
      setOperationActiveIndex(LINEAR_OPERATION_PHASES.length);
      setOperationSupportingText("Linear workspace verified.");
      void loadWorkspaceOptions();
      await loadBootstrap();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Apply failed");
    } finally {
      applyInFlightRef.current = false;
      setLoading(null);
    }
  };

  const canContinue =
    verifiedSuccess ||
    readiness.steps.find((step) => step.id === "linear-workspace")?.status ===
      "complete" ||
    summary.workspace.configured;

  const draftReady =
    draftAssociations.length > 0 ||
    pendingCreates.length > 0 ||
    addFormComplete;
  const controlsLocked = loading === "apply";

  return (
    <SectionCard
      title={`Step 2 of ${GUIDED_SETUP_STEP_COUNT} · Set up Linear workspace`}
      description="Add one or more Linear team and project associations, review the draft list, then apply the initial workspace setup."
    >
      <div className={SPACING.stackSm}>
        {!apiKeyConfigured ? (
          <p className="text-sm text-muted-foreground">
            Add your Linear API key in Step 1 before configuring the Linear workspace.
          </p>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="linear-team-mode">Team</Label>
                <GuidedSelect
                  id="linear-team-mode"
                  value={teamMode}
                  onChange={(event) => {
                    setTeamMode(event.target.value as "existing" | "create");
                    invalidatePreview();
                  }}
                  disabled={controlsLocked}
                >
                  <option value="existing">Use existing team</option>
                  <option value="create">Create new team</option>
                </GuidedSelect>
                {teamMode === "existing" ? (
                  <>
                    <GuidedSelect
                      value={teamId}
                      onChange={(event) => {
                        setTeamId(event.target.value);
                        setProjectId("");
                        setAddProjectIds([]);
                        invalidatePreview();
                      }}
                      disabled={controlsLocked || optionsLoading}
                    >
                      <option value="">Select a team…</option>
                      {teams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name} ({team.key})
                        </option>
                      ))}
                    </GuidedSelect>
                    {optionsLoading ? (
                      <p className="text-sm text-muted-foreground">
                        Loading Linear teams…
                      </p>
                    ) : null}
                    {!optionsLoading && teams.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No Linear teams found for this API key.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="space-y-2">
                    <Input
                      placeholder="Team name"
                      value={teamName}
                      disabled={controlsLocked}
                      onChange={(event) => {
                        setTeamName(event.target.value);
                        invalidatePreview();
                      }}
                    />
                    <Input
                      placeholder="Team key (e.g. ENG)"
                      value={teamKey}
                      disabled={controlsLocked}
                      onChange={(event) => {
                        setTeamKey(event.target.value);
                        invalidatePreview();
                      }}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="linear-project-mode">Project</Label>
                {!forceCreateProject ? (
                  <GuidedSelect
                    id="linear-project-mode"
                    value={projectMode}
                    onChange={(event) => {
                      setProjectMode(event.target.value as "existing" | "create");
                      invalidatePreview();
                    }}
                    disabled={controlsLocked}
                  >
                    <option value="existing">Use existing project</option>
                    <option value="create">Create new project</option>
                  </GuidedSelect>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Create a new project for this Linear team.
                  </p>
                )}
                {!forceCreateProject && projectMode === "existing" ? (
                  <>
                    {teamMode === "existing" && teamId ? (
                      <div className="space-y-2 rounded-md border border-border/70 p-3">
                        {projectOptions.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No Linear projects are associated with this team.
                          </p>
                        ) : (
                          projectOptions.map((project) => {
                            const key = linearAssociationKey({
                              workspaceId: workspaceId || bootstrap?.workspaceId || "",
                              teamId,
                              projectId: project.id,
                            });
                            const alreadyConfigured = configuredKeys.has(key);
                            return (
                              <label
                                key={project.id}
                                className="flex items-center gap-2 text-sm"
                              >
                                <input
                                  type="checkbox"
                                  disabled={controlsLocked || alreadyConfigured}
                                  checked={addProjectIds.includes(project.id)}
                                  onChange={(event) => {
                                    setAddProjectIds((current) =>
                                      event.target.checked
                                        ? [...current, project.id]
                                        : current.filter((id) => id !== project.id),
                                    );
                                    invalidatePreview();
                                  }}
                                />
                                <span>
                                  {project.name}
                                  {alreadyConfigured ? " (already in draft)" : ""}
                                </span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    ) : (
                      <GuidedSelect
                        value={projectId}
                        onChange={(event) => {
                          setProjectId(event.target.value);
                          invalidatePreview();
                        }}
                        disabled={controlsLocked || optionsLoading}
                      >
                        <option value="">Select a project…</option>
                        {projectOptions.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </GuidedSelect>
                    )}
                    {optionsLoading ? (
                      <p className="text-sm text-muted-foreground">
                        Loading Linear projects…
                      </p>
                    ) : null}
                  </>
                ) : (
                  <Input
                    placeholder="Project name"
                    value={projectName}
                    disabled={controlsLocked}
                    onChange={(event) => {
                      setProjectName(event.target.value);
                      invalidatePreview();
                    }}
                  />
                )}
              </div>
            </div>

            {repoOptions.length > 0 ? (
              <div className="space-y-2">
                <Label htmlFor="guided-linear-target-repo">Target repository</Label>
                <GuidedSelect
                  id="guided-linear-target-repo"
                  value={addRepoId}
                  onChange={(event) => {
                    setAddRepoId(event.target.value);
                    invalidatePreview();
                  }}
                  disabled={controlsLocked}
                >
                  {repoOptions.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.targetRepo}
                    </option>
                  ))}
                </GuidedSelect>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Target repositories are not configured yet. You can still draft create
                selections here; they will map onto the first configured repo when harness
                config exists.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addCurrentSelectionToDraft}
                disabled={controlsLocked || !addFormComplete}
              >
                Add to draft
              </Button>
            </div>

            {optionsError ? (
              <p className="text-sm text-destructive">{optionsError}</p>
            ) : null}
            {bootstrapError ? (
              <p className="text-sm text-destructive">{bootstrapError}</p>
            ) : null}

            <div className="space-y-3 rounded-md border border-border/70 p-3">
              <p className="text-sm font-medium">Draft associations</p>
              {groupedDraft.size === 0 && pendingCreates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No Linear associations added yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {[...groupedDraft.entries()].map(([groupTeamId, associations]) => (
                    <div key={groupTeamId} className="rounded-md border border-border/70 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          {formatLinearTeamLabel({
                            teamName: associations[0]?.teamName,
                            teamKey: associations[0]?.teamKey ?? groupTeamId,
                          })}{" "}
                          · {associations.length} project
                          {associations.length === 1 ? "" : "s"}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={controlsLocked}
                          onClick={() => {
                            setDraftAssociations((current) =>
                              removeDraftTeam(current, groupTeamId),
                            );
                            invalidatePreview();
                          }}
                        >
                          Remove team
                        </Button>
                      </div>
                      <ul className="mt-2 space-y-2">
                        {associations.map((association) => (
                          <li
                            key={linearAssociationKey(association)}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-2 text-sm"
                          >
                            <div>
                              <p>{association.projectName}</p>
                              {association.targetRepo ? (
                                <p className="text-xs text-muted-foreground">
                                  {association.targetRepo}
                                </p>
                              ) : null}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={controlsLocked}
                              onClick={() => {
                                setDraftAssociations((current) =>
                                  removeDraftAssociation(current, association),
                                );
                                invalidatePreview();
                              }}
                            >
                              Remove
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {pendingCreates.length > 0 ? (
                    <ul className="space-y-2">
                      {pendingCreates.map((entry) => (
                        <li
                          key={entry.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/20 px-3 py-2 text-sm"
                        >
                          <div>
                            <p>{describePendingCreate(entry)}</p>
                            <p className="text-xs text-muted-foreground">
                              Will be created on apply
                              {entry.targetRepo ? ` · ${entry.targetRepo}` : ""}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={controlsLocked}
                            onClick={() => {
                              setPendingCreates((current) =>
                                current.filter((item) => item.id !== entry.id),
                              );
                              invalidatePreview();
                            }}
                          >
                            Remove
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {summary.workspace.configured ? (
                <StatusBadge
                  label={`Team ${formatLinearTeamLabel({
                    teamName:
                      summary.controlPlane?.linear?.teamName ??
                      summary.controlPlane?.linearWorkspace?.teams[0]?.teamName,
                    teamKey: summary.workspace.teamKey ?? "",
                  })} configured`}
                  variant="success"
                />
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handlePreview()}
                disabled={loading !== null || !draftReady}
              >
                {loading === "preview" ? "Previewing…" : "Preview Linear setup"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void refreshSummary()}
                disabled={loading !== null}
              >
                Refresh
              </Button>
            </div>

            {previewDisclosed && previewIsCurrent && preview ? (
              <div className="rounded-md border border-border bg-muted/10 p-3 text-sm space-y-2">
                {previewMode === "workspace" && workspacePreview ? (
                  <pre className="whitespace-pre-wrap font-sans text-sm">
                    {formatWorkspacePreviewSummary(workspacePreview)}
                  </pre>
                ) : setupPreview ? (
                  <>
                    <p>
                      Missing creatable statuses:{" "}
                      {setupPreview.missingStatuses.length > 0
                        ? setupPreview.missingStatuses.join(", ")
                        : "none"}
                    </p>
                    <p>
                      Dispatch triggers: {setupPreview.dispatchTriggerStatuses.join(", ")}
                    </p>
                    {setupPreview.repairActions.length > 0 ? (
                      <div className="space-y-2">
                        <p className="font-medium">Workflow status repairs</p>
                        <ul className="space-y-2">
                          {setupPreview.repairActions.map((repair) => (
                            <li
                              key={repair.existingStatusId}
                              className="rounded-md border border-border bg-background p-2"
                            >
                              <p className="font-medium">{repair.statusName}</p>
                              <p className="text-muted-foreground">{repair.explanation}</p>
                              <p>
                                Current category:{" "}
                                {formatLinearCategoryLabel(repair.actualCategory)} · Required:{" "}
                                {formatLinearCategoryLabel(repair.expectedCategory)}
                              </p>
                              <p>
                                Affected issues: {repair.affectedIssueCount} · Strategy:{" "}
                                {repair.repairStrategy}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {setupPreview.manualSteps.length > 0 ? (
                      <ul className="list-disc pl-5 text-muted-foreground">
                        {setupPreview.manualSteps.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : null}
                {previewError ? (
                  <p className="text-destructive">{previewError}</p>
                ) : null}
              </div>
            ) : null}

            {loading !== "apply" && !verifiedSuccess ? (
              <RemoteActionConfirmation
                scope="linear-write"
                variant="guided"
                confirmed={confirmed}
                disabled={loading !== null || !draftReady}
                disabledReason={
                  !draftReady
                    ? "Add at least one Linear team and project association before confirming."
                    : undefined
                }
                onConfirmedChange={setConfirmed}
              />
            ) : null}

            {loading === "apply" ? (
              <GuidedOperationPanel
                phases={buildGuidedOperationPhases({
                  labels: [...LINEAR_OPERATION_PHASES],
                  activeIndex: operationActiveIndex,
                })}
                supportingText={operationSupportingText}
              />
            ) : null}

            {!verifiedSuccess && loading !== "apply" ? (
              <div className={FORM.actions}>
                <Button
                  type="button"
                  onClick={() => void handleApply()}
                  disabled={
                    loading !== null ||
                    !confirmed ||
                    !draftReady ||
                    Boolean(preview?.validationError)
                  }
                >
                  Apply Linear workspace setup
                </Button>
              </div>
            ) : null}

            {error ? <SetupApplyResult success={false} message={error} /> : null}
            {verifiedSuccess && applyResult ? (
              <GuidedStepSuccessPanel
                heading="Linear workspace verified"
                explanation="The selected Linear team, project, and workflow statuses are ready."
                details={[
                  "created" in applyResult
                    ? `Created: ${applyResult.created.join(", ") || "none"}`
                    : `Operations: ${applyResult.operationsCompleted.length}`,
                  "skipped" in applyResult
                    ? `Reused: ${applyResult.skipped.join(", ") || "none"}`
                    : "Reused: none",
                  "repaired" in applyResult
                    ? `Repaired: ${applyResult.repaired.join(", ") || "none"}`
                    : "Repaired: none",
                ]}
                continueLabel="Continue to Vercel bridge"
                onContinue={onContinue}
              />
            ) : null}

            {canContinue && !verifiedSuccess ? (
              <Button type="button" onClick={onContinue}>
                Continue to Vercel bridge
              </Button>
            ) : null}
          </>
        )}
      </div>
    </SectionCard>
  );
}
