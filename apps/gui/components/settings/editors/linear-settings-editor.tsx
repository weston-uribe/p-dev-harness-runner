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
  groupAssociationsByTeam,
  removeDraftAssociation,
  removeDraftTeam,
} from "@/lib/linear-association-draft";
import { Button } from "@/components/ui/button";
import { sanitizeSettingsErrorMessage } from "@/lib/settings/settings-mutation";
import {
  applyLinearWorkspace,
  previewLinearWorkspace,
  syncLinearAssociationCloudConfig,
} from "@/lib/settings/settings-setup-client";
import { pickDisplayedLinearWorkspaceName } from "@/lib/linear-workspace-identity";
import { formatLinearEntityHealthLabel } from "@harness/setup/linear-entity-health-label";
import { LinearProvisionForm } from "@/components/settings/linear-provision-form";

type LinearEditorInitialData = {
  summary: LinearSetupSummary;
  associations: ResolvedLinearAssociation[];
  repos: Array<{ id: string; targetRepo: string }>;
  expectedCommittedFingerprint: string;
  workspaceId: string;
  workspaceName: string;
  driftWarnings: Array<{
    code: string;
    message: string;
    teamId?: string;
    projectId?: string;
  }>;
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
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);

  const linearApiKeyConfigured = summary.linearApiKeyConfigured;
  const evidence = summary.controlPlane?.linearWorkspace;
  const workspaceName = pickDisplayedLinearWorkspaceName({
    bootstrapName: initialData.workspaceName,
    healthName: initialData.workspaceHealth?.linear.workspaceName,
  });
  const grouped = useMemo(
    () => groupAssociationsByTeam(associations),
    [associations],
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
      if (result.cloudSync?.status === "partial_success") {
        setActionMessage(
          `${successMessage} Cloud harness config sync still needs attention.`,
        );
        setActionError(result.cloudSync.error ?? null);
      } else {
        setActionMessage(successMessage);
      }
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

  const retryCloudSync = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await syncLinearAssociationCloudConfig();
      if (result.status === "synced") {
        setActionMessage("Cloud harness config synchronized.");
        setActionError(null);
      } else {
        setActionError(result.error ?? "Cloud harness config sync failed.");
      }
    } catch (error) {
      setActionError(
        sanitizeSettingsErrorMessage(
          error instanceof Error
            ? error.message
            : "Cloud harness config sync failed.",
        ),
      );
    } finally {
      setBusy(false);
    }
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
              const teamDrift = initialData.driftWarnings.some(
                (warning) =>
                  warning.teamId === teamId ||
                  warning.code === "team_id_mismatch" ||
                  warning.code === "association_count_mismatch",
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
                        Health:{" "}
                        {formatLinearEntityHealthLabel(teamEvidence?.health, {
                          drift: teamDrift && !teamEvidence,
                        })}
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
                      const projectDrift = initialData.driftWarnings.some(
                        (warning) =>
                          warning.projectId === association.projectId ||
                          warning.code === "project_id_mismatch",
                      );
                      return (
                        <li
                          key={linearAssociationKey(association)}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-2 text-sm"
                        >
                          <div>
                            <p>{association.projectName}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatLinearEntityHealthLabel(
                                projectEvidence?.health,
                                {
                                  drift: projectDrift && !projectEvidence,
                                },
                              )}
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

      {optionsError ? (
        <p className="text-sm text-destructive">{optionsError}</p>
      ) : null}

      <LinearProvisionForm
        associations={associations}
        expectedCommittedFingerprint={expectedCommittedFingerprint}
        workspaceId={initialData.workspaceId}
        workspaceName={workspaceName}
        repos={initialData.repos}
        teams={teams}
        projects={projects}
        optionsLoading={optionsLoading}
        linearApiKeyConfigured={linearApiKeyConfigured}
        disabled={busy}
        onError={(message) => setActionError(message || null)}
        onRetryCloudSync={retryCloudSync}
        onApplied={(result) => {
          setSummary(result.summary);
          setAssociations(result.associations);
          setExpectedCommittedFingerprint(result.expectedCommittedFingerprint);
          setActionMessage(result.message);
          if (result.cloudSync?.status === "partial_success") {
            setActionError(result.cloudSync.error ?? null);
          } else {
            setActionError(null);
          }
          // Refresh options so newly created teams/projects appear.
          requestGenerationRef.current += 1;
          const generation = requestGenerationRef.current;
          void (async () => {
            try {
              const response = await fetch("/api/setup/linear-options");
              const data = await response.json();
              if (generation !== requestGenerationRef.current || !response.ok) {
                return;
              }
              setTeams((data.teams ?? []) as LinearTeamSummary[]);
              setProjects((data.projects ?? []) as LinearProjectSummary[]);
            } catch {
              // Options refresh is best-effort after apply.
            }
          })();
        }}
      />
    </div>
  );
}
