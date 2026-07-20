"use client";

import { useRef, useState } from "react";
import type { ResolvedLinearAssociation } from "@harness/config/resolve-linear-workspace";
import type {
  LinearProjectSummary,
  LinearTeamSummary,
} from "@harness/setup/linear-setup-client";
import type { LinearSetupSummary } from "@harness/setup/linear-setup-summary";
import {
  addProjectsToDraft,
  foldResolvedAssociationIntoDraft,
} from "@/lib/linear-association-draft";
import {
  buildSetupPlanPayload,
  buildWorkspacePlanPayload,
  isLinearProvisionFormComplete,
  supportsRequestedProvisionMode,
  type LinearProvisionProjectMode,
  type LinearProvisionTeamMode,
} from "@/lib/linear-provisioning";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GuidedSelect } from "@/components/ui/guided-select";
import { sanitizeSettingsErrorMessage } from "@/lib/settings/settings-mutation";
import {
  applyLinearSetup,
  applyLinearWorkspace,
  previewLinearSetup,
  previewLinearWorkspace,
} from "@/lib/settings/settings-setup-client";

type CloudSyncResult = {
  status: "synced" | "partial_success";
  fingerprint: string;
  harnessRepository?: string;
  error?: string;
  retryable?: boolean;
  syncedAt?: string;
};

export type LinearProvisionFormProps = {
  associations: ResolvedLinearAssociation[];
  expectedCommittedFingerprint: string;
  workspaceId: string;
  workspaceName: string;
  repos: Array<{ id: string; targetRepo: string }>;
  teams: LinearTeamSummary[];
  projects: LinearProjectSummary[];
  optionsLoading: boolean;
  linearApiKeyConfigured: boolean;
  disabled?: boolean;
  onApplied: (result: {
    associations: ResolvedLinearAssociation[];
    expectedCommittedFingerprint: string;
    summary: LinearSetupSummary;
    message: string;
    cloudSync: CloudSyncResult | null;
  }) => void;
  onError: (message: string) => void;
  onRetryCloudSync?: () => Promise<void>;
};

export function LinearProvisionForm({
  associations,
  expectedCommittedFingerprint,
  workspaceId,
  workspaceName,
  repos,
  teams,
  projects,
  optionsLoading,
  linearApiKeyConfigured,
  disabled = false,
  onApplied,
  onError,
  onRetryCloudSync,
}: LinearProvisionFormProps) {
  const [teamMode, setTeamMode] = useState<LinearProvisionTeamMode>("existing");
  const [projectMode, setProjectMode] =
    useState<LinearProvisionProjectMode>("existing");
  const [teamId, setTeamId] = useState("");
  const [teamKey, setTeamKey] = useState("");
  const [teamName, setTeamName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [partialCloudSync, setPartialCloudSync] =
    useState<CloudSyncResult | null>(null);
  const submitGenerationRef = useRef(0);
  const defaultRepo = repos[0];

  const formComplete = isLinearProvisionFormComplete({
    teamMode,
    teamId,
    teamKey,
    teamName,
    projectMode,
    projectId,
    projectName,
  });
  const modeSupported = supportsRequestedProvisionMode({
    teamMode,
    projectMode,
  });

  const projectOptions = teamId
    ? projects.filter((project) => project.teamIds.includes(teamId))
    : [];

  const runProvision = async () => {
    if (
      !formComplete ||
      !modeSupported ||
      !defaultRepo ||
      !linearApiKeyConfigured ||
      busy
    ) {
      return;
    }

    const generation = ++submitGenerationRef.current;
    setBusy(true);
    setPartialCloudSync(null);
    onError("");

    try {
      const needsCreate =
        teamMode === "create" || projectMode === "create";
      let nextAssociations = [...associations];

      if (needsCreate) {
        const setupPlan = buildSetupPlanPayload({
          teamMode,
          teamId,
          teamKey,
          teamName,
          projectMode,
          projectId,
          projectName,
          targetRepo: defaultRepo.targetRepo,
        });
        const preview = await previewLinearSetup(setupPlan);
        if (preview.validationError) {
          throw new Error(preview.validationError);
        }
        if (generation !== submitGenerationRef.current) {
          return;
        }
        const confirmed = window.confirm(
          "Create or reuse the selected Linear team/project, repair required PDev workflow statuses, and add the association to this harness?",
        );
        if (!confirmed) {
          return;
        }
        const setupResult = await applyLinearSetup({
          plan: setupPlan,
          fingerprint: preview.fingerprint,
        });
        if (generation !== submitGenerationRef.current) {
          return;
        }
        if (!setupResult.apply.verified) {
          throw new Error("Linear create apply finished without verification.");
        }
        nextAssociations = foldResolvedAssociationIntoDraft({
          draft: nextAssociations,
          association: {
            workspaceId,
            teamId: setupResult.apply.team.id,
            teamKey: setupResult.apply.team.key,
            teamName: setupResult.apply.team.name,
            projectId: setupResult.apply.project.id,
            projectName: setupResult.apply.project.name,
            targetRepo: defaultRepo.targetRepo,
            repoConfigId: defaultRepo.id,
          },
        });
      } else {
        const selectedTeam = teams.find((team) => team.id === teamId);
        const selectedProject = projects.find(
          (project) => project.id === projectId,
        );
        if (!selectedTeam || !selectedProject) {
          throw new Error("Selected Linear team or project is unavailable.");
        }
        const confirmed = window.confirm(
          `Add "${selectedProject.name}" from "${selectedTeam.name}" to PDev?\n\nThis will write Linear status configuration for required PDev statuses and sync cloud harness config.`,
        );
        if (!confirmed) {
          return;
        }
        nextAssociations = addProjectsToDraft({
          draft: nextAssociations,
          workspaceId,
          team: {
            id: selectedTeam.id,
            key: selectedTeam.key,
            name: selectedTeam.name,
          },
          projects: [{ id: selectedProject.id, name: selectedProject.name }],
          targetRepo: defaultRepo.targetRepo,
          repoConfigId: defaultRepo.id,
        });
      }

      const workspacePlan = buildWorkspacePlanPayload({
        expectedCommittedFingerprint,
        workspaceId,
        workspaceName,
        requestedAssociations: nextAssociations,
      });
      const workspacePreview = await previewLinearWorkspace(workspacePlan);
      if (workspacePreview.validationError) {
        throw new Error(workspacePreview.validationError);
      }
      if (generation !== submitGenerationRef.current) {
        return;
      }
      const workspaceResult = await applyLinearWorkspace({
        plan: workspacePlan,
        fingerprint: workspacePreview.fingerprint,
      });
      if (generation !== submitGenerationRef.current) {
        return;
      }
      if (!workspaceResult.apply.verified) {
        throw new Error("Linear workspace apply finished without verification.");
      }

      const cloudSync =
        (workspaceResult.cloudSync as CloudSyncResult | null | undefined) ??
        null;
      if (cloudSync?.status === "partial_success") {
        setPartialCloudSync(cloudSync);
      } else {
        setPartialCloudSync(null);
      }

      setTeamId("");
      setTeamKey("");
      setTeamName("");
      setProjectId("");
      setProjectName("");
      setTeamMode("existing");
      setProjectMode("existing");

      onApplied({
        associations: nextAssociations,
        expectedCommittedFingerprint:
          workspaceResult.expectedCommittedFingerprint,
        summary: workspaceResult.summary as LinearSetupSummary,
        message:
          cloudSync?.status === "partial_success"
            ? "Linear associations were saved locally. Cloud harness config sync still needs attention."
            : "Team and project associations updated.",
        cloudSync,
      });
    } catch (error) {
      if (generation !== submitGenerationRef.current) {
        return;
      }
      onError(
        sanitizeSettingsErrorMessage(
          error instanceof Error ? error.message : "Linear provision failed.",
        ),
      );
    } finally {
      if (generation === submitGenerationRef.current) {
        setBusy(false);
      }
    }
  };

  return (
    <section className="space-y-4 rounded-md border border-border p-4">
      <h3 className="text-sm font-semibold">Add teams and projects</h3>
      {!linearApiKeyConfigured ? (
        <p className="text-sm text-muted-foreground">
          Configure a Linear API key in Connections before adding associations.
        </p>
      ) : null}
      {!defaultRepo ? (
        <p className="text-sm text-muted-foreground">
          Add a target repository before associating Linear teams and projects.
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="settings-linear-team-mode">Team</Label>
          <GuidedSelect
            id="settings-linear-team-mode"
            value={teamMode}
            disabled={!linearApiKeyConfigured || busy || disabled}
            onChange={(event) => {
              const next = event.target.value as LinearProvisionTeamMode;
              setTeamMode(next);
              setTeamId("");
              setTeamKey("");
              setTeamName("");
              setProjectId("");
              if (next === "create") {
                setProjectMode("create");
              }
            }}
          >
            <option value="existing">Use existing team</option>
            <option value="create">Create new team</option>
          </GuidedSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor="settings-linear-project-mode">Project</Label>
          <GuidedSelect
            id="settings-linear-project-mode"
            value={projectMode}
            disabled={
              !linearApiKeyConfigured ||
              busy ||
              disabled ||
              teamMode === "create"
            }
            onChange={(event) => {
              setProjectMode(event.target.value as LinearProvisionProjectMode);
              setProjectId("");
              setProjectName("");
            }}
          >
            <option value="existing">Use existing project</option>
            <option value="create">Create new project</option>
          </GuidedSelect>
        </div>
      </div>

      {teamMode === "existing" ? (
        <div className="space-y-2">
          <Label htmlFor="settings-linear-add-team">Existing team</Label>
          <GuidedSelect
            id="settings-linear-add-team"
            value={teamId}
            disabled={optionsLoading || !linearApiKeyConfigured || busy || disabled}
            onChange={(event) => {
              setTeamId(event.target.value);
              setProjectId("");
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
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="settings-linear-team-name">Team name</Label>
            <Input
              id="settings-linear-team-name"
              value={teamName}
              disabled={busy || disabled}
              onChange={(event) => setTeamName(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-linear-team-key">Team key</Label>
            <Input
              id="settings-linear-team-key"
              value={teamKey}
              disabled={busy || disabled}
              onChange={(event) => setTeamKey(event.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
      )}

      {projectMode === "existing" ? (
        <div className="space-y-2">
          <Label htmlFor="settings-linear-add-project">Existing project</Label>
          <GuidedSelect
            id="settings-linear-add-project"
            value={projectId}
            disabled={
              !teamId || optionsLoading || !linearApiKeyConfigured || busy || disabled
            }
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">
              {!teamId
                ? "Select a team first"
                : optionsLoading
                  ? "Loading projects…"
                  : "Select a project"}
            </option>
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </GuidedSelect>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="settings-linear-project-name">Project name</Label>
          <Input
            id="settings-linear-project-name"
            value={projectName}
            disabled={busy || disabled}
            onChange={(event) => setProjectName(event.target.value)}
            autoComplete="off"
          />
        </div>
      )}

      {!modeSupported ? (
        <p className="text-sm text-muted-foreground">
          Creating a team requires creating a new project in the same operation.
        </p>
      ) : null}

      <Button
        type="button"
        disabled={
          !formComplete ||
          !modeSupported ||
          !defaultRepo ||
          !linearApiKeyConfigured ||
          busy ||
          disabled
        }
        onClick={() => void runProvision()}
      >
        {busy ? "Applying…" : "Preview and apply association"}
      </Button>

      {partialCloudSync?.status === "partial_success" ? (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p>
            Linear associations were saved locally. Cloud harness config sync
            did not finish: {partialCloudSync.error}
          </p>
          {onRetryCloudSync ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onRetryCloudSync()}
            >
              Retry cloud config sync
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
