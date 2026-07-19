"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LinearSetupSummary } from "@harness/setup/linear-setup-summary";
import type { LinearWorkspacePreview } from "@harness/setup/linear-workspace-plan";
import type { ResolvedLinearAssociation } from "@harness/config/resolve-linear-workspace";
import type {
  LinearProjectSummary,
  LinearTeamSummary,
} from "@harness/setup/linear-setup-client";
import {
  formatLinearTeamLabel,
  linearAssociationKey,
} from "@harness/config/resolve-linear-workspace";
import {
  addProjectsToDraft,
  buildConfiguredAssociationKeys,
  groupAssociationsByTeam,
  removeDraftAssociation,
  removeDraftTeam,
} from "@/lib/linear-association-draft";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { GuidedSelect } from "@/components/ui/guided-select";
import { SettingsMutationPanel } from "@/components/settings/settings-mutation-panel";
import {
  initialSettingsMutationState,
  sanitizeSettingsErrorMessage,
  type SettingsMutationState,
} from "@/lib/settings/settings-mutation";
import {
  applyLinearWorkspace,
  previewLinearWorkspace,
} from "@/lib/settings/settings-setup-client";

type LinearEditorInitialData = {
  summary: LinearSetupSummary;
  associations: ResolvedLinearAssociation[];
  repos: Array<{ id: string; targetRepo: string }>;
  expectedCommittedFingerprint: string;
  workspaceId: string;
  workspaceName: string;
  driftWarnings: Array<{ code: string; message: string }>;
};

type LinearSettingsEditorProps = {
  initialData: LinearEditorInitialData;
};

export function LinearSettingsEditor({ initialData }: LinearSettingsEditorProps) {
  const [summary, setSummary] = useState(initialData.summary);
  const [committedAssociations, setCommittedAssociations] = useState(
    initialData.associations,
  );
  const [draftAssociations, setDraftAssociations] = useState(
    initialData.associations,
  );
  const [expectedCommittedFingerprint, setExpectedCommittedFingerprint] =
    useState(initialData.expectedCommittedFingerprint);
  const [teams, setTeams] = useState<LinearTeamSummary[]>([]);
  const [projects, setProjects] = useState<LinearProjectSummary[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [addTeamId, setAddTeamId] = useState("");
  const [addProjectIds, setAddProjectIds] = useState<string[]>([]);
  const [addRepoId, setAddRepoId] = useState(initialData.repos[0]?.id ?? "");
  const [mutation, setMutation] = useState<
    SettingsMutationState<LinearWorkspacePreview>
  >(initialSettingsMutationState());
  const [confirmed, setConfirmed] = useState(false);
  const requestGenerationRef = useRef(0);

  const linearApiKeyConfigured = summary.linearApiKeyConfigured;
  const evidence = summary.controlPlane?.linearWorkspace;
  const groupedCommitted = useMemo(
    () => groupAssociationsByTeam(committedAssociations),
    [committedAssociations],
  );
  const groupedDraft = useMemo(
    () => groupAssociationsByTeam(draftAssociations),
    [draftAssociations],
  );

  useEffect(() => {
    if (!linearApiKeyConfigured) {
      requestGenerationRef.current += 1;
      setTeams([]);
      setProjects([]);
      setOptionsLoading(false);
      setOptionsError(null);
      return;
    }

    const generation = ++requestGenerationRef.current;
    let cancelled = false;

    const loadOptions = async () => {
      setOptionsLoading(true);
      setOptionsError(null);
      try {
        const response = await fetch("/api/setup/linear-options");
        const data = await response.json();
        if (cancelled || generation !== requestGenerationRef.current) {
          return;
        }
        if (!response.ok) {
          throw new Error(data.error ?? "Failed to load Linear options");
        }
        setTeams((data.teams ?? []) as LinearTeamSummary[]);
        setProjects((data.projects ?? []) as LinearProjectSummary[]);
      } catch (error) {
        if (cancelled || generation !== requestGenerationRef.current) {
          return;
        }
        setTeams([]);
        setProjects([]);
        setOptionsError(
          error instanceof Error ? error.message : "Failed to load Linear options",
        );
      } finally {
        if (!cancelled && generation === requestGenerationRef.current) {
          setOptionsLoading(false);
        }
      }
    };

    void loadOptions();

    return () => {
      cancelled = true;
      requestGenerationRef.current += 1;
    };
  }, [linearApiKeyConfigured]);

  const configuredKeys = useMemo(
    () => buildConfiguredAssociationKeys(draftAssociations),
    [draftAssociations],
  );

  const projectOptions = useMemo(() => {
    if (!addTeamId) {
      return [];
    }
    return projects.filter((project) => project.teamIds.includes(addTeamId));
  }, [projects, addTeamId]);

  const selectedTeam = teams.find((team) => team.id === addTeamId);
  const targetRepo =
    initialData.repos.find((repo) => repo.id === addRepoId)?.targetRepo ?? "";

  const buildWorkspacePlan = () => ({
    expectedCommittedFingerprint,
    workspaceId: initialData.workspaceId,
    workspaceName: initialData.workspaceName,
    requestedAssociations: draftAssociations,
  });

  const formatPreviewSummary = (preview: LinearWorkspacePreview) => {
    const lines = [
      `Teams to add: ${preview.impactSummary.teamsToAdd.join(", ") || "none"}`,
      `Projects to add: ${preview.impactSummary.projectsToAdd.join(", ") || "none"}`,
      `Teams to repair: ${preview.impactSummary.teamsToRepair.join(", ") || "none"}`,
      `Projects to detach: ${preview.impactSummary.projectsToDetach.join(", ") || "none"}`,
      `Teams to detach: ${preview.impactSummary.teamsToDetach.join(", ") || "none"}`,
      `Metadata blocks to remove: ${
        preview.impactSummary.metadataBlocksToRemove.join(", ") || "none"
      }`,
      ...preview.impactSummary.explicitNonActions,
    ];
    return lines.join("\n");
  };

  const runPreview = async () => {
    setMutation((current) => ({ ...current, phase: "previewing", error: null }));
    setConfirmed(false);
    try {
      const preview = await previewLinearWorkspace(buildWorkspacePlan());
      if (preview.validationError) {
        throw new Error(preview.validationError);
      }
      setMutation({
        phase: "preview-ready",
        preview,
        error: null,
        successMessage: null,
      });
    } catch (error) {
      setMutation({
        phase: "error",
        preview: null,
        error: sanitizeSettingsErrorMessage(
          error instanceof Error ? error.message : "Linear preview failed.",
        ),
        successMessage: null,
      });
    }
  };

  const runApply = async () => {
    setMutation((current) => ({ ...current, phase: "applying", error: null }));
    try {
      const result = await applyLinearWorkspace({
        plan: buildWorkspacePlan(),
        fingerprint: mutation.preview?.fingerprint,
      });
      if (!result.apply.verified) {
        throw new Error("Linear apply finished without verification.");
      }
      setSummary(result.summary as LinearSetupSummary);
      setCommittedAssociations(initialData.associations);
      setDraftAssociations(initialData.associations);
      setExpectedCommittedFingerprint(result.expectedCommittedFingerprint);
      setMutation({
        phase: "success",
        preview: null,
        error: null,
        successMessage: "Linear workspace updated.",
      });
      setConfirmed(false);
      window.location.reload();
    } catch (error) {
      setMutation({
        phase: "error",
        preview: mutation.preview,
        error: sanitizeSettingsErrorMessage(
          error instanceof Error ? error.message : "Linear apply failed.",
        ),
        successMessage: null,
      });
    }
  };

  const addSelectedProjects = () => {
    if (!selectedTeam || !targetRepo || addProjectIds.length === 0) {
      return;
    }
    const selectedProjects = addProjectIds
      .map((projectId) => projects.find((item) => item.id === projectId))
      .filter((project): project is LinearProjectSummary => Boolean(project));
    setDraftAssociations((current) =>
      addProjectsToDraft({
        draft: current,
        workspaceId: initialData.workspaceId,
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
        repoConfigId: addRepoId,
      }),
    );
    setAddProjectIds([]);
  };

  const detachProject = (association: ResolvedLinearAssociation) => {
    const confirmedDetach = window.confirm(
      `Remove "${association.projectName}" from PDev? Issues in this team and project will no longer be processed by this harness. The Linear project and its issues will not be deleted.`,
    );
    if (!confirmedDetach) {
      return;
    }
    setDraftAssociations((current) => removeDraftAssociation(current, association));
  };

  const detachTeam = (teamId: string) => {
    const teamAssociations = draftAssociations.filter(
      (association) => association.teamId === teamId,
    );
    const projectLines = teamAssociations
      .map((association) => `- ${association.projectName}`)
      .join("\n");
    const confirmedDetach = window.confirm(
      `Remove "${teamAssociations[0]?.teamKey ?? teamId}" from PDev?\n\nThis will also detach these configured projects:\n\n${projectLines}\n\nIssues belonging to this team will no longer be processed by this harness.\n\nNothing will be deleted from Linear.`,
    );
    if (!confirmedDetach) {
      return;
    }
    setDraftAssociations((current) => removeDraftTeam(current, teamId));
  };

  const draftDirty =
    JSON.stringify(committedAssociations) !== JSON.stringify(draftAssociations);

  return (
    <div className="space-y-8">
      <section className="space-y-3 rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Connected workspace</h3>
        <p className="text-sm">
          <span className="text-muted-foreground">Workspace:</span>{" "}
          {initialData.workspaceName}
        </p>
        <p className="text-sm">
          <span className="text-muted-foreground">Credential:</span>{" "}
          {linearApiKeyConfigured ? "Configured" : "Missing LINEAR_API_KEY"}
        </p>
        <p className="text-sm">
          <span className="text-muted-foreground">Configured teams:</span>{" "}
          {groupedCommitted.size}
        </p>
        <p className="text-sm">
          <span className="text-muted-foreground">Configured projects:</span>{" "}
          {committedAssociations.length}
        </p>
        {initialData.driftWarnings.length > 0 ? (
          <div className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
            {initialData.driftWarnings.map((warning) => (
              <p key={warning.code}>{warning.message}</p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="space-y-4 rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Configured teams and projects</h3>
        {groupedDraft.size === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Linear team and project associations are configured yet.
          </p>
        ) : (
          <div className="space-y-4">
            {[...groupedDraft.entries()].map(([teamId, associations]) => {
              const teamEvidence = evidence?.teams.find(
                (team) => team.teamId === teamId,
              );
              return (
                <div key={teamId} className="rounded-md border border-border/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">
                        {formatLinearTeamLabel({
                          teamName: associations[0]?.teamName,
                          teamKey: associations[0]?.teamKey ?? teamId,
                        })}{" "}
                        · {associations.length} project
                        {associations.length === 1 ? "" : "s"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Health: {teamEvidence?.health ?? "verification_pending"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => detachTeam(teamId)}
                    >
                      Remove from PDev
                    </Button>
                  </div>
                  <ul className="mt-3 space-y-2">
                    {associations.map((association) => {
                      const projectEvidence = teamEvidence?.projects.find(
                        (project) => project.projectId === association.projectId,
                      );
                      return (
                        <li
                          key={linearAssociationKey(association)}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-2 text-sm"
                        >
                          <div>
                            <p>{association.projectName}</p>
                            <p className="text-xs text-muted-foreground">
                              {association.targetRepo}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {projectEvidence?.health ?? "verification_pending"}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => detachProject(association)}
                          >
                            Detach
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Add teams and projects</h3>
        {!linearApiKeyConfigured ? (
          <p className="text-sm text-muted-foreground">
            Configure a Linear API key in Connections before adding associations.
          </p>
        ) : null}
        {optionsError ? (
          <p className="text-sm text-destructive">{optionsError}</p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="settings-linear-add-team">Team</Label>
            <GuidedSelect
              id="settings-linear-add-team"
              value={addTeamId}
              disabled={optionsLoading || !linearApiKeyConfigured}
              onChange={(event) => {
                setAddTeamId(event.target.value);
                setAddProjectIds([]);
              }}
            >
              <option value="">
                {optionsLoading ? "Loading teams…" : "Select a team"}
              </option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name} ({team.key})
                </option>
              ))}
            </GuidedSelect>
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-linear-target-repo">Target repository</Label>
            <GuidedSelect
              id="settings-linear-target-repo"
              value={addRepoId}
              onChange={(event) => setAddRepoId(event.target.value)}
            >
              {initialData.repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.targetRepo}
                </option>
              ))}
            </GuidedSelect>
          </div>
        </div>
        {addTeamId ? (
          <div className="space-y-2">
            <Label>Projects on this team</Label>
            <div className="space-y-2 rounded-md border border-border/70 p-3">
              {projectOptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No Linear projects are associated with this team.
                </p>
              ) : (
                projectOptions.map((project) => {
                  const key = linearAssociationKey({
                    workspaceId: initialData.workspaceId,
                    teamId: addTeamId,
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
                        disabled={alreadyConfigured}
                        checked={addProjectIds.includes(project.id)}
                        onChange={(event) => {
                          setAddProjectIds((current) =>
                            event.target.checked
                              ? [...current, project.id]
                              : current.filter((id) => id !== project.id),
                          );
                        }}
                      />
                      <span>
                        {project.name}
                        {alreadyConfigured ? " (already configured)" : ""}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!addProjectIds.length || !targetRepo}
              onClick={addSelectedProjects}
            >
              Add selected projects to draft
            </Button>
          </div>
        ) : null}
      </section>

      <SettingsMutationPanel
        phase={mutation.phase}
        error={mutation.error}
        successMessage={mutation.successMessage}
        previewPolicy="optional"
        previewSummary={
          mutation.preview ? formatPreviewSummary(mutation.preview) : null
        }
        confirmScope="linear-write"
        confirmed={confirmed}
        onConfirmedChange={setConfirmed}
        onPreview={() => void runPreview()}
        onApply={() => void runApply()}
        disablePreview={!draftDirty || draftAssociations.length === 0}
        disableApply={!draftDirty || draftAssociations.length === 0}
      />
    </div>
  );
}
