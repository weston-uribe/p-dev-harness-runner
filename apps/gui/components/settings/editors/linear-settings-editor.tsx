"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LinearSetupSummary } from "@harness/setup/linear-setup-summary";
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
import { sanitizeSettingsErrorMessage } from "@/lib/settings/settings-mutation";
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
  workspaceHealth?: import("@harness/setup/workspace-health-snapshot").WorkspaceHealthSnapshot;
};

type LinearSettingsEditorProps = {
  initialData: LinearEditorInitialData;
};

export function LinearSettingsEditor({ initialData }: LinearSettingsEditorProps) {
  const [summary, setSummary] = useState(initialData.summary);
  const [associations, setAssociations] = useState(initialData.associations);
  const [expectedCommittedFingerprint, setExpectedCommittedFingerprint] =
    useState(initialData.expectedCommittedFingerprint);
  const [teams, setTeams] = useState<LinearTeamSummary[]>([]);
  const [projects, setProjects] = useState<LinearProjectSummary[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [addTeamId, setAddTeamId] = useState("");
  const [addProjectIds, setAddProjectIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);

  const linearApiKeyConfigured = summary.linearApiKeyConfigured;
  const evidence = summary.controlPlane?.linearWorkspace;
  const workspaceName =
    initialData.workspaceHealth?.linear.workspaceName?.trim() ||
    initialData.workspaceName;
  const grouped = useMemo(
    () => groupAssociationsByTeam(associations),
    [associations],
  );
  const defaultRepo = initialData.repos[0];

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
    () => buildConfiguredAssociationKeys(associations),
    [associations],
  );

  const projectOptions = useMemo(() => {
    if (!addTeamId) {
      return [];
    }
    return projects.filter((project) => project.teamIds.includes(addTeamId));
  }, [projects, addTeamId]);

  const selectedTeam = teams.find((team) => team.id === addTeamId);

  const commitAssociations = async (
    next: ResolvedLinearAssociation[],
    successMessage: string,
  ) => {
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const plan = {
        expectedCommittedFingerprint,
        workspaceId: initialData.workspaceId,
        workspaceName,
        requestedAssociations: next,
      };
      const preview = await previewLinearWorkspace(plan);
      if (preview.validationError) {
        throw new Error(preview.validationError);
      }
      const result = await applyLinearWorkspace({
        plan,
        fingerprint: preview.fingerprint,
      });
      if (!result.apply.verified) {
        throw new Error("Linear apply finished without verification.");
      }
      setSummary(result.summary as LinearSetupSummary);
      setAssociations(next);
      setExpectedCommittedFingerprint(result.expectedCommittedFingerprint);
      setActionMessage(successMessage);
    } catch (error) {
      setActionError(
        sanitizeSettingsErrorMessage(
          error instanceof Error ? error.message : "Linear update failed.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const addSelectedProjects = () => {
    if (!selectedTeam || !defaultRepo || addProjectIds.length === 0) {
      return;
    }
    const selectedProjects = addProjectIds
      .map((projectId) => projects.find((item) => item.id === projectId))
      .filter((project): project is LinearProjectSummary => Boolean(project));
    const confirmedAdd = window.confirm(
      `Add ${selectedProjects.length} project(s) from "${selectedTeam.name}" to PDev?\n\nThis will write Linear status configuration for required PDev statuses.`,
    );
    if (!confirmedAdd) {
      return;
    }
    const next = addProjectsToDraft({
      draft: associations,
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
      targetRepo: defaultRepo.targetRepo,
      repoConfigId: defaultRepo.id,
    });
    setAddProjectIds([]);
    void commitAssociations(next, "Team and project associations updated.");
  };

  const detachProject = (association: ResolvedLinearAssociation) => {
    const confirmedDetach = window.confirm(
      `Remove "${association.projectName}" from PDev? Issues in this team and project will no longer be processed by this harness. The Linear project and its issues will not be deleted.`,
    );
    if (!confirmedDetach) {
      return;
    }
    const next = removeDraftAssociation(associations, association);
    void commitAssociations(next, "Project detached from PDev.");
  };

  const detachTeam = (teamId: string) => {
    const teamAssociations = associations.filter(
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
    const next = removeDraftTeam(associations, teamId);
    void commitAssociations(next, "Team removed from PDev.");
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3 rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Connected workspace</h3>
        <p className="text-sm">
          <span className="text-muted-foreground">Workspace:</span>{" "}
          {workspaceName}
        </p>
        {initialData.driftWarnings.length > 0 ? (
          <div className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
            {initialData.driftWarnings.map((warning) => (
              <p key={warning.code}>{warning.message}</p>
            ))}
          </div>
        ) : null}
        {actionMessage ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-300">
            {actionMessage}
          </p>
        ) : null}
        {actionError ? (
          <p className="text-sm text-destructive">{actionError}</p>
        ) : null}
        {busy ? (
          <p className="text-sm text-muted-foreground">Updating Linear…</p>
        ) : null}
      </section>

      <section className="space-y-4 rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Configured teams and projects</h3>
        {grouped.size === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Linear team and project associations are configured yet.
          </p>
        ) : (
          <div className="space-y-4">
            {[...grouped.entries()].map(([teamId, teamAssociations]) => {
              const teamEvidence = evidence?.teams.find(
                (team) => team.teamId === teamId,
              );
              return (
                <div key={teamId} className="rounded-md border border-border/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">
                        {formatLinearTeamLabel({
                          teamName: teamAssociations[0]?.teamName,
                          teamKey: teamAssociations[0]?.teamKey ?? teamId,
                        })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Health: {teamEvidence?.health ?? "verification_pending"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => detachTeam(teamId)}
                    >
                      Remove from PDev
                    </Button>
                  </div>
                  <ul className="mt-3 space-y-2">
                    {teamAssociations.map((association) => {
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
                              {projectEvidence?.health ?? "verification_pending"}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
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
        <div className="space-y-2">
          <Label htmlFor="settings-linear-add-team">Team</Label>
          <GuidedSelect
            id="settings-linear-add-team"
            value={addTeamId}
            disabled={optionsLoading || !linearApiKeyConfigured || busy}
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
                        disabled={alreadyConfigured || busy}
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
              disabled={!addProjectIds.length || !defaultRepo || busy}
              onClick={addSelectedProjects}
            >
              Add selected projects
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
