"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VercelSetupSummary } from "@harness/setup/vercel-setup-summary";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { GuidedSelect } from "@/components/ui/guided-select";
import { sanitizeSettingsErrorMessage } from "@/lib/settings/settings-mutation";
import {
  applyVercelBridge,
  previewVercelBridge,
} from "@/lib/settings/settings-setup-client";
import type { WorkspaceHealthSnapshot } from "@harness/setup/workspace-health-snapshot";

type DeploymentsSettingsEditorProps = {
  initialSummary: VercelSetupSummary;
  workspaceHealth?: WorkspaceHealthSnapshot;
};

type ScopeOption = { id: string; label: string };
type ProjectOption = { id: string; name: string };

export function DeploymentsSettingsEditor({
  initialSummary,
  workspaceHealth,
}: DeploymentsSettingsEditorProps) {
  const [summary, setSummary] = useState(initialSummary);
  const [scopes, setScopes] = useState<ScopeOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const committedTeamId =
    workspaceHealth?.vercel.selectedScope?.teamId ??
    summary.controlPlane?.vercel?.teamId ??
    "";
  const committedProjectId =
    workspaceHealth?.vercel.selectedProject?.projectId ??
    summary.controlPlane?.vercel?.projectId ??
    "";
  const committedScopeLabel =
    workspaceHealth?.vercel.selectedScope?.teamName ??
    summary.controlPlane?.vercel?.teamName ??
    (committedTeamId ? "Team" : "Personal");
  const [teamId, setTeamId] = useState(committedTeamId);
  const [projectId, setProjectId] = useState(committedProjectId);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const teamsRequestIdRef = useRef(0);
  const projectsRequestIdRef = useRef(0);
  const credentialFingerprint = summary.vercelTokenConfigured
    ? "vercel-configured"
    : "vercel-missing";
  const loadedCredentialRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadTeams = useCallback(async () => {
    if (!summary.vercelTokenConfigured) {
      return;
    }
    const requestId = ++teamsRequestIdRef.current;
    setTeamsLoading(true);
    setOptionsError(null);
    try {
      const response = await fetch("/api/setup/vercel-bridge-options");
      const data = await response.json();
      if (!mountedRef.current || requestId !== teamsRequestIdRef.current) {
        return;
      }
      if (!response.ok) {
        throw new Error(data.error ?? data.loadError ?? "Failed to load Vercel teams");
      }
      const nextScopes: ScopeOption[] = (data.scopes ?? []).map(
        (scope: { id: string; label: string }) => ({
          id: scope.id,
          label: scope.label,
        }),
      );
      setScopes(nextScopes);
      // Keep durable scope selected — do not fall back to personal when a team is stored.
      setTeamId((current) => {
        if (
          committedTeamId &&
          nextScopes.some((scope) => scope.id === committedTeamId)
        ) {
          return committedTeamId;
        }
        if (current && nextScopes.some((scope) => scope.id === current)) {
          return current;
        }
        return committedTeamId;
      });
      if (data.loadError) {
        setOptionsError(data.loadError);
      }
      loadedCredentialRef.current = credentialFingerprint;
    } catch (error) {
      if (!mountedRef.current || requestId !== teamsRequestIdRef.current) {
        return;
      }
      setOptionsError(
        sanitizeSettingsErrorMessage(
          error instanceof Error ? error.message : "Failed to load Vercel teams",
        ),
      );
    } finally {
      if (mountedRef.current && requestId === teamsRequestIdRef.current) {
        setTeamsLoading(false);
      }
    }
  }, [committedTeamId, credentialFingerprint, summary.vercelTokenConfigured]);

  const loadProjects = useCallback(
    async (scopeId: string) => {
      if (!summary.vercelTokenConfigured) {
        return;
      }
      const requestId = ++projectsRequestIdRef.current;
      setProjectsLoading(true);
      setOptionsError(null);
      try {
        const query = `?teamId=${encodeURIComponent(scopeId)}&projectsOnly=true`;
        const response = await fetch(`/api/setup/vercel-bridge-options${query}`);
        const data = await response.json();
        if (!mountedRef.current || requestId !== projectsRequestIdRef.current) {
          return;
        }
        if (!response.ok) {
          throw new Error(
            data.error ?? data.loadError ?? "Failed to load Vercel projects",
          );
        }
        const nextProjects: ProjectOption[] = data.projects ?? [];
        setProjects(nextProjects);
        setProjectId((current) => {
          if (nextProjects.some((project) => project.id === current)) {
            return current;
          }
          if (
            committedProjectId &&
            nextProjects.some((project) => project.id === committedProjectId)
          ) {
            return committedProjectId;
          }
          // Clear only an unsaved selection that does not belong to the new team.
          if (current && current !== committedProjectId) {
            return "";
          }
          return current;
        });
      } catch (error) {
        if (!mountedRef.current || requestId !== projectsRequestIdRef.current) {
          return;
        }
        setOptionsError(
          sanitizeSettingsErrorMessage(
            error instanceof Error
              ? error.message
              : "Failed to load Vercel projects",
          ),
        );
      } finally {
        if (mountedRef.current && requestId === projectsRequestIdRef.current) {
          setProjectsLoading(false);
        }
      }
    },
    [committedProjectId, summary.vercelTokenConfigured],
  );

  useEffect(() => {
    if (!summary.vercelTokenConfigured) {
      loadedCredentialRef.current = null;
      return;
    }
    if (loadedCredentialRef.current === credentialFingerprint) {
      return;
    }
    void loadTeams();
  }, [credentialFingerprint, loadTeams, summary.vercelTokenConfigured]);

  useEffect(() => {
    if (!summary.vercelTokenConfigured) {
      return;
    }
    void loadProjects(teamId);
  }, [loadProjects, summary.vercelTokenConfigured, teamId]);

  const buildPlanPayload = useCallback(
    () => ({
      team: { mode: "existing" as const, teamId },
      project: { mode: "existing" as const, projectId },
      teamId,
      projectId,
      linearTeamId: summary.controlPlane?.linear?.teamId,
      envInput: {
        HARNESS_TEAM_KEY: summary.controlPlane?.linear?.teamKey,
      },
    }),
    [projectId, summary.controlPlane?.linear?.teamId, summary.controlPlane?.linear?.teamKey, teamId],
  );

  const dirty =
    teamId !== committedTeamId || projectId !== committedProjectId;
  const selectionComplete = Boolean(projectId);

  const saveSelection = useCallback(async () => {
    if (!selectionComplete || !dirty) {
      return;
    }
    const scopeLabel =
      scopes.find((scope) => scope.id === teamId)?.label ?? committedScopeLabel;
    const projectLabel =
      projects.find((project) => project.id === projectId)?.name ?? projectId;
    const confirmedSave = window.confirm(
      `Save Vercel deployment selection?\n\nScope: ${scopeLabel}\nProject: ${projectLabel}\n\nPDev will update the automation bridge and verify the connection.`,
    );
    if (!confirmedSave) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const freshPreview = await previewVercelBridge(buildPlanPayload());
      if (freshPreview.validationError) {
        throw new Error(freshPreview.validationError);
      }
      const result = await applyVercelBridge({
        plan: buildPlanPayload(),
        fingerprint: freshPreview.fingerprint,
      });
      setSummary(result.summary as VercelSetupSummary);
      setActionMessage(
        "PDev automation bridge updated. Redeploy verification may continue in Vercel.",
      );
    } catch (error) {
      setActionError(
        sanitizeSettingsErrorMessage(
          error instanceof Error ? error.message : "Vercel apply failed.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [
    buildPlanPayload,
    committedScopeLabel,
    dirty,
    projectId,
    projects,
    scopes,
    selectionComplete,
    teamId,
  ]);

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-border p-4 text-sm">
        <p>
          <span className="text-muted-foreground">Scope:</span>{" "}
          {committedScopeLabel}
        </p>
        <p className="mt-2">
          <span className="text-muted-foreground">Current project:</span>{" "}
          {workspaceHealth?.vercel.selectedProject?.projectName ??
            summary.controlPlane?.vercel?.projectName ??
            "Not configured"}
        </p>
        <p className="mt-2">
          <span className="text-muted-foreground">Production URL:</span>{" "}
          {workspaceHealth?.vercel.productionUrl ??
            summary.controlPlane?.vercel?.productionUrl ??
            "—"}
        </p>
        <p className="mt-2">
          <span className="text-muted-foreground">Bridge:</span>{" "}
          {workspaceHealth
            ? workspaceHealth.vercel.bridgeDeployed
              ? workspaceHealth.vercel.bridgeReachable
                ? "Deployed, reachable"
                : "Deployed, not reachable"
              : "Not deployed"
            : "—"}
        </p>
        <p className="mt-2">
          <span className="text-muted-foreground">Linear webhook:</span>{" "}
          {workspaceHealth?.vercel.webhookVerified
            ? "Verified"
            : workspaceHealth?.vercel.webhookConfigured
              ? "Configured, not verified"
              : summary.controlPlane?.vercel?.linearWebhookVerified
                ? "Verified"
                : "Not verified"}
        </p>
        {workspaceHealth?.vercel.lastVerifiedAt ? (
          <p className="mt-2">
            <span className="text-muted-foreground">Last verified:</span>{" "}
            {workspaceHealth.vercel.lastVerifiedAt}
          </p>
        ) : null}
      </div>

      {!summary.vercelTokenConfigured ? (
        <p className="text-sm text-muted-foreground">
          Connect Vercel in{" "}
          <Link href="/settings/connections" className="underline">
            Settings → Connections
          </Link>{" "}
          to configure deployments.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Configure optional application preview and production deployment
            behavior for the selected Vercel team and project.
          </p>

          {optionsError ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <p className="text-destructive">{optionsError}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  loadedCredentialRef.current = null;
                  void loadTeams();
                  void loadProjects(teamId);
                }}
              >
                Retry
              </Button>
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="settings-vercel-team">Team</Label>
              <GuidedSelect
                id="settings-vercel-team"
                value={teamId}
                disabled={teamsLoading && scopes.length === 0}
                onChange={(event) => {
                  setTeamId(event.target.value);
                  setActionMessage(null);
                  setActionError(null);
                }}
              >
                {scopes.length === 0 ? (
                  <option value={committedTeamId}>
                    {teamsLoading
                      ? "Loading Vercel teams…"
                      : committedScopeLabel}
                  </option>
                ) : null}
                {scopes.map((scope) => (
                  <option key={scope.id || "personal"} value={scope.id}>
                    {scope.label}
                  </option>
                ))}
              </GuidedSelect>
              {teamsLoading ? (
                <p className="text-xs text-muted-foreground">
                  Loading Vercel teams…
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-vercel-project">Project</Label>
              <GuidedSelect
                id="settings-vercel-project"
                value={projectId}
                disabled={projectsLoading && projects.length === 0}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setActionMessage(null);
                  setActionError(null);
                }}
              >
                <option value="">
                  {projectsLoading
                    ? "Loading Vercel projects…"
                    : "Select a project"}
                </option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </GuidedSelect>
              {projectsLoading ? (
                <p className="text-xs text-muted-foreground">
                  Loading Vercel projects…
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {actionMessage ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-300">
          {actionMessage}
        </p>
      ) : null}
      {actionError ? (
        <p className="text-sm text-destructive">{actionError}</p>
      ) : null}

      {dirty && summary.vercelTokenConfigured ? (
        <div className="rounded-md border border-border p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Unsaved deployment selection. Confirm to update the automation
            bridge.
          </p>
          <Button
            type="button"
            disabled={!selectionComplete || busy}
            onClick={() => void saveSelection()}
          >
            {busy ? "Saving…" : "Save deployment selection"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
