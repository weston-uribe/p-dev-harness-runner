import { access, readFile } from "node:fs/promises";
import type { LinearClient } from "@linear/sdk";
import { harnessConfigSchema } from "../config/schema.js";
import {
  updateControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import type { LinearWorkspaceSelection } from "./control-plane-types.js";
import {
  createLinearProject,
  createLinearSetupClient,
  createLinearTeam,
  createLinearWorkflowState,
  isDuplicateWorkflowStateError,
  listLinearProjects,
  listLinearTeams,
  listTeamWorkflowStates,
  type LinearProjectSummary,
  type LinearTeamSummary,
} from "./linear-setup-client.js";
import { lookupRequiredStatus } from "./linear-status-contract.js";
import {
  LINEAR_SETUP_ACTIONS,
  buildNewProductProjectDescription,
  findExistingProjectForCreateInput,
  findExistingTeamForCreateInput,
  isWorkflowStatusCoverageComplete,
  matchWorkflowStates,
  normalizeLinearName,
  previewLinearSetup,
  type LinearSetupPlanInput,
  type LinearSetupPreview,
} from "./linear-setup-plan.js";
import {
  writeLinearSetupProgress,
  type LinearSetupProgressPhase,
} from "./linear-setup-progress.js";
import { executeWorkflowStatusRepairs } from "./linear-workflow-status-repair.js";
import {
  assertRemoteSetupConfirmed,
  assertRemoteSetupFingerprint,
  assertRemoteSetupPermissionScope,
} from "./remote-actions.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";
import { resolveLocalFilePaths } from "./setup-state.js";

export interface LinearSetupApplyResult {
  actionId: string;
  team: LinearTeamSummary;
  project: LinearProjectSummary;
  created: string[];
  skipped: string[];
  repaired: string[];
  statusCoverageComplete: boolean;
  verified: boolean;
  fingerprint: string;
  permission: typeof SETUP_PERMISSIONS.linearWrite;
  configUpdated: boolean;
}

async function updateHarnessConfigLinearMapping(input: {
  cwd?: string;
  workspaceId?: string;
  teamId: string;
  teamKey: string;
  teamName: string;
  projectId: string;
  projectName: string;
  targetRepo?: string;
  repoConfigId?: string;
}): Promise<boolean> {
  const paths = resolveLocalFilePaths(input.cwd);
  try {
    await access(paths.configLocal);
  } catch {
    return false;
  }

  const raw = await readFile(paths.configLocal, "utf8");
  const parsed = harnessConfigSchema.parse(JSON.parse(raw));
  const targetRepo =
    input.targetRepo ??
    parsed.repos[0]?.targetRepo;
  const repoConfigId =
    input.repoConfigId ??
    parsed.repos.find((repo) => repo.targetRepo === targetRepo)?.id ??
    parsed.repos[0]?.id;

  if (!targetRepo || !repoConfigId) {
    return false;
  }

  const workspaceId =
    input.workspaceId?.trim() ||
    parsed.linear?.workspaceId?.trim() ||
    "unknown-workspace";

  const { buildRequestedHarnessConfig } = await import("./linear-workspace-plan.js");
  const next = buildRequestedHarnessConfig({
    current: parsed,
    workspaceId,
    requestedAssociations: [
      {
        workspaceId,
        teamId: input.teamId,
        teamKey: input.teamKey,
        teamName: input.teamName,
        projectId: input.projectId,
        projectName: input.projectName,
        targetRepo,
        repoConfigId,
      },
    ],
  });

  const { writeConfigLocal } = await import("./config-writer.js");
  await writeConfigLocal({
    paths,
    content: `${JSON.stringify(next, null, 2)}\n`,
    force: true,
  });
  return true;
}

export async function ensureWorkflowStatesForTeam(input: {
  client: LinearClient;
  teamId: string;
  created: string[];
  skipped: string[];
}): Promise<boolean> {
  const { client, teamId, created, skipped } = input;

  const runEnsurePass = async () => {
    const existingStates = await listTeamWorkflowStates(client, teamId);
    const plan = matchWorkflowStates(existingStates);

    for (const entry of plan) {
      if (entry.action !== "create") {
        if (entry.present) {
          skipped.push(`status:${entry.name}`);
        }
        continue;
      }

      const required = lookupRequiredStatus(entry.name);
      if (!required) {
        continue;
      }

      try {
        await createLinearWorkflowState(client, {
          teamId,
          name: entry.name,
          type: required.category,
        });
        created.push(`status:${entry.name}`);
      } catch (error) {
        if (!isDuplicateWorkflowStateError(error)) {
          throw error;
        }
        const refreshed = await listTeamWorkflowStates(client, teamId);
        const reused = refreshed.find(
          (state) =>
            normalizeLinearName(state.name) === normalizeLinearName(entry.name),
        );
        if (!reused) {
          throw error;
        }
        skipped.push(`status:${entry.name}`);
      }
    }
  };

  await runEnsurePass();

  const finalStates = await listTeamWorkflowStates(client, teamId);
  return isWorkflowStatusCoverageComplete(matchWorkflowStates(finalStates));
}

export async function applyLinearSetup(input: {
  plan: LinearSetupPlanInput;
  confirmed: boolean;
  fingerprint: string;
  cwd?: string;
}): Promise<LinearSetupApplyResult> {
  const progressStartedAt = new Date().toISOString();
  const writeProgress = (
    phase: LinearSetupProgressPhase,
    completed = false,
  ) =>
    writeLinearSetupProgress(
      {
        actionId: LINEAR_SETUP_ACTIONS.apply.id,
        phase,
        startedAt: progressStartedAt,
        completed,
      },
      input.cwd,
    );

  assertRemoteSetupConfirmed(input.confirmed);
  assertRemoteSetupPermissionScope(
    LINEAR_SETUP_ACTIONS.apply.permission.scope,
    SETUP_PERMISSIONS.linearWrite.scope,
  );

  await writeProgress("validate");
  const preview = await previewLinearSetup(input.plan);
  assertRemoteSetupFingerprint(input.fingerprint, preview.fingerprint);
  if (preview.validationError) {
    throw new Error(preview.validationError);
  }

  const client = createLinearSetupClient(input.plan.linearApiKey);
  const created: string[] = [];
  const skipped: string[] = [];
  const repaired: string[] = [];

  let team: LinearTeamSummary;
  await writeProgress("team");
  if (input.plan.team.mode === "create") {
    if (!input.plan.team.teamName || !input.plan.team.teamKey) {
      throw new Error("New Linear team requires name and key.");
    }
    const teams = await listLinearTeams(client);
    const existingTeam = findExistingTeamForCreateInput(teams, {
      teamKey: input.plan.team.teamKey,
      teamName: input.plan.team.teamName,
    });
    if (existingTeam) {
      team = existingTeam;
      skipped.push(`team:${team.key}`);
    } else {
      team = await createLinearTeam(client, {
        name: input.plan.team.teamName,
        key: input.plan.team.teamKey,
      });
      created.push(`team:${team.key}`);
    }
  } else {
    const existing = preview.selectedTeam;
    if (!existing) {
      throw new Error("Selected Linear team is required for apply.");
    }
    team = existing;
    skipped.push(`team:${team.key}`);
  }

  let project: LinearProjectSummary;
  await writeProgress("project");
  if (input.plan.project.mode === "create") {
    if (!input.plan.project.projectName) {
      throw new Error("New Linear project requires a name.");
    }
    const projects = await listLinearProjects(client);
    const existingProject = findExistingProjectForCreateInput(projects, {
      projectName: input.plan.project.projectName,
      teamId: team.id,
    });
    if (existingProject) {
      project = existingProject;
      skipped.push(`project:${project.name}`);
    } else {
      const description =
        input.plan.project.targetRepo
          ? buildNewProductProjectDescription({
              baseDescription: input.plan.project.description,
              targetRepo: input.plan.project.targetRepo,
            })
          : input.plan.project.description;
      project = await createLinearProject(client, {
        name: input.plan.project.projectName,
        teamIds: [team.id],
        description,
      });
      created.push(`project:${project.name}`);
    }
  } else {
    const existing = preview.selectedProject;
    if (!existing) {
      throw new Error("Selected Linear project is required for apply.");
    }
    project = existing;
    skipped.push(`project:${project.name}`);
  }

  await writeProgress("statuses");
  let statusCoverageComplete = await ensureWorkflowStatesForTeam({
    client,
    teamId: team.id,
    created,
    skipped,
  });

  const repairEntries = preview.workflowStates.filter(
    (entry) => entry.action === "repair",
  );
  if (repairEntries.length > 0) {
    const repairResults = await executeWorkflowStatusRepairs({
      client,
      teamId: team.id,
      entries: repairEntries,
    });
    repaired.push(...repairResults);
    const finalStates = await listTeamWorkflowStates(client, team.id);
    statusCoverageComplete = isWorkflowStatusCoverageComplete(
      matchWorkflowStates(finalStates),
    );
  }

  await writeProgress("verify");
  const selection: LinearWorkspaceSelection = {
    teamMode: input.plan.team.mode,
    teamId: team.id,
    teamKey: team.key,
    teamName: team.name,
    projectMode: input.plan.project.mode,
    projectId: project.id,
    projectName: project.name,
    statusCoverageComplete,
    appliedFingerprint: preview.fingerprint,
    appliedAt: new Date().toISOString(),
  };

  await updateControlPlaneSetupState({ linear: selection }, input.cwd);
  const configUpdated = await updateHarnessConfigLinearMapping({
    cwd: input.cwd,
    teamId: team.id,
    teamKey: team.key,
    teamName: team.name,
    projectId: project.id,
    projectName: project.name,
  });
  await writeProgress("verify", true);

  return {
    actionId: LINEAR_SETUP_ACTIONS.apply.id,
    team,
    project,
    created,
    skipped,
    repaired,
    statusCoverageComplete,
    verified: Boolean(team.id && project.id && statusCoverageComplete),
    fingerprint: preview.fingerprint,
    permission: LINEAR_SETUP_ACTIONS.apply.permission,
    configUpdated,
  };
}

export type { LinearSetupPlanInput, LinearSetupPreview };
