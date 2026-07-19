import { access, readFile } from "node:fs/promises";
import type { LinearClient } from "@linear/sdk";
import { harnessConfigSchema } from "../config/schema.js";
import type { HarnessConfig } from "../config/types.js";
import {
  evidenceFromAssociations,
  resolveLinearAssociationsFromConfig,
} from "../config/resolve-linear-workspace.js";
import {
  removeHarnessMetadataFromDescription,
  upsertHarnessMetadataInDescription,
} from "../linear/project-harness-metadata.js";
import {
  computeLinearAssociationsFingerprint,
} from "./linear-workspace-migration.js";
import {
  createLinearSetupClient,
  getLinearProject,
  listTeamWorkflowStates,
  updateLinearProjectDescription,
} from "./linear-setup-client.js";
import { ensureWorkflowStatesForTeam } from "./linear-setup-apply.js";
import { executeWorkflowStatusRepairs } from "./linear-workflow-status-repair.js";
import { matchWorkflowStates } from "./linear-setup-plan.js";
import {
  buildRequestedHarnessConfig,
  previewLinearWorkspace,
  type LinearWorkspaceDraftAssociation,
  type LinearWorkspaceOperation,
  type LinearWorkspacePlanInput,
  LINEAR_WORKSPACE_ACTIONS,
} from "./linear-workspace-plan.js";
import {
  assertRemoteSetupConfirmed,
  assertRemoteSetupFingerprint,
  assertRemoteSetupPermissionScope,
} from "./remote-actions.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";
import {
  readControlPlaneSetupState,
  writeControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import type { LinearWorkspaceEvidence } from "./control-plane-types.js";
import { resolveLocalFilePaths } from "./setup-state.js";

export type LinearWorkspaceApplyResult = {
  actionId: string;
  verified: boolean;
  fingerprint: string;
  committedFingerprint: string;
  operationsCompleted: LinearWorkspaceOperation[];
  failedOperation?: {
    operation: LinearWorkspaceOperation;
    reason: string;
  };
  evidence: LinearWorkspaceEvidence;
  configUpdated: boolean;
  permission: typeof SETUP_PERMISSIONS.linearWrite;
};

async function readHarnessConfigLocal(cwd?: string): Promise<HarnessConfig | null> {
  const paths = resolveLocalFilePaths(cwd);
  try {
    await access(paths.configLocal);
    const raw = await readFile(paths.configLocal, "utf8");
    return harnessConfigSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeHarnessConfigLocal(input: {
  cwd?: string;
  config: HarnessConfig;
}): Promise<void> {
  const paths = resolveLocalFilePaths(input.cwd);
  const { writeConfigLocal } = await import("./config-writer.js");
  await writeConfigLocal({
    paths,
    content: `${JSON.stringify(input.config, null, 2)}\n`,
    force: true,
  });
}

async function repairProjectMetadata(input: {
  client: LinearClient;
  projectId: string;
  targetRepo: string;
}): Promise<void> {
  const project = await getLinearProject(input.client, input.projectId);
  if (!project) {
    throw new Error(`Linear project ${input.projectId} was not found during metadata repair.`);
  }
  const nextDescription = upsertHarnessMetadataInDescription(project.description, {
    targetRepo: input.targetRepo.replace(/^https:\/\/github\.com\//, ""),
    productInitialization: "uninitialized",
  });
  await updateLinearProjectDescription(input.client, input.projectId, nextDescription);
}

async function removeProjectMetadataBlock(input: {
  client: LinearClient;
  projectId: string;
}): Promise<void> {
  const project = await getLinearProject(input.client, input.projectId);
  if (!project) {
    return;
  }
  const nextDescription = removeHarnessMetadataFromDescription(project.description);
  await updateLinearProjectDescription(input.client, input.projectId, nextDescription);
}

async function executeWorkspaceOperation(input: {
  client: LinearClient;
  operation: LinearWorkspaceOperation;
  created: string[];
  skipped: string[];
  repaired: string[];
}): Promise<void> {
  const { client, operation, created, skipped, repaired } = input;

  switch (operation.type) {
    case "add_team":
      skipped.push(`team:${operation.teamKey}`);
      return;
    case "repair_team_statuses": {
      const complete = await ensureWorkflowStatesForTeam({
        client,
        teamId: operation.teamId,
        created,
        skipped,
      });
      const states = await listTeamWorkflowStates(client, operation.teamId);
      const repairEntries = matchWorkflowStates(states).filter(
        (entry) => entry.action === "repair",
      );
      if (repairEntries.length > 0) {
        repaired.push(
          ...(await executeWorkflowStatusRepairs({
            client,
            teamId: operation.teamId,
            entries: repairEntries,
          })),
        );
      }
      if (!complete && repairEntries.length === 0) {
        throw new Error(
          `Required workflow statuses are incomplete for team ${operation.teamKey}.`,
        );
      }
      return;
    }
    case "add_project_association":
      skipped.push(`association:${operation.teamId}/${operation.projectId}`);
      return;
    case "repair_project_metadata":
      await repairProjectMetadata({
        client,
        projectId: operation.projectId,
        targetRepo: operation.targetRepo,
      });
      repaired.push(`metadata:${operation.projectId}`);
      return;
    case "detach_project_association":
      skipped.push(`detach:${operation.teamId}/${operation.projectId}`);
      return;
    case "detach_team":
      skipped.push(`detach-team:${operation.teamKey}`);
      return;
    case "remove_project_metadata_block":
      await removeProjectMetadataBlock({
        client,
        projectId: operation.projectId,
      });
      repaired.push(`metadata-removed:${operation.projectId}`);
      return;
    default:
      return;
  }
}

export async function applyLinearWorkspace(input: {
  plan: LinearWorkspacePlanInput;
  confirmed: boolean;
  fingerprint?: string;
  cwd?: string;
}): Promise<LinearWorkspaceApplyResult> {
  assertRemoteSetupConfirmed(input.confirmed);
  assertRemoteSetupPermissionScope(
    LINEAR_WORKSPACE_ACTIONS.apply.permission.scope,
    SETUP_PERMISSIONS.linearWrite.scope,
  );

  const preview = await previewLinearWorkspace(input.plan);
  if (preview.validationError) {
    throw new Error(preview.validationError);
  }
  if (input.fingerprint) {
    assertRemoteSetupFingerprint(input.fingerprint, preview.fingerprint);
  }

  const committedConfig = await readHarnessConfigLocal(input.cwd);
  if (!committedConfig) {
    throw new Error("Harness config is required before applying Linear workspace changes.");
  }

  const committedAssociations = resolveLinearAssociationsFromConfig(committedConfig);
  const committedFingerprint = computeLinearAssociationsFingerprint(committedConfig);
  const created: string[] = [];
  const skipped: string[] = [];
  const repaired: string[] = [];
  const client = createLinearSetupClient(input.plan.linearApiKey);
  const completed: LinearWorkspaceOperation[] = [];

  try {
    for (const operation of preview.operations) {
      await executeWorkspaceOperation({
        client,
        operation,
        created,
        skipped,
        repaired,
      });
      completed.push(operation);
    }
  } catch (error) {
    return {
      actionId: LINEAR_WORKSPACE_ACTIONS.apply.id,
      verified: false,
      fingerprint: preview.fingerprint,
      committedFingerprint,
      operationsCompleted: completed,
      failedOperation: preview.operations[completed.length]
        ? {
            operation: preview.operations[completed.length]!,
            reason: error instanceof Error ? error.message : String(error),
          }
        : undefined,
      evidence:
        (await readControlPlaneSetupState(input.cwd))?.linearWorkspace ??
        evidenceFromAssociations({
          workspaceId: input.plan.workspaceId,
          workspaceName: input.plan.workspaceName,
          associations: committedAssociations,
        }),
      configUpdated: false,
      permission: LINEAR_WORKSPACE_ACTIONS.apply.permission,
    };
  }

  const nextConfig = buildRequestedHarnessConfig({
    current: committedConfig,
    requestedAssociations: input.plan.requestedAssociations,
    workspaceId: input.plan.workspaceId,
  });

  await writeHarnessConfigLocal({ cwd: input.cwd, config: nextConfig });

  const resolvedAssociations = resolveLinearAssociationsFromConfig(nextConfig);
  const evidence = evidenceFromAssociations({
    workspaceId: input.plan.workspaceId,
    workspaceName: input.plan.workspaceName,
    associations: resolvedAssociations,
    appliedFingerprint: preview.fingerprint,
    appliedAt: new Date().toISOString(),
  });

  evidence.teams = evidence.teams.map((team) => {
    const teamAssociations = resolvedAssociations.filter(
      (association) => association.teamId === team.teamId,
    );
    const teamHealthy = teamAssociations.length > 0;
    return {
      ...team,
      health: teamHealthy ? "healthy" : "needs_repair",
      lastVerifiedAt: new Date().toISOString(),
      projects: team.projects.map((project) => ({
        ...project,
        health: "healthy" as const,
        lastVerifiedAt: new Date().toISOString(),
      })),
    };
  });

  const controlPlane = (await readControlPlaneSetupState(input.cwd)) ?? {
    version: 1 as const,
  };
  await writeControlPlaneSetupState(
    {
      ...controlPlane,
      version: 1,
      linearWorkspace: evidence,
    },
    input.cwd,
  );

  return {
    actionId: LINEAR_WORKSPACE_ACTIONS.apply.id,
    verified: true,
    fingerprint: preview.fingerprint,
    committedFingerprint,
    operationsCompleted: completed,
    evidence,
    configUpdated: true,
    permission: LINEAR_WORKSPACE_ACTIONS.apply.permission,
  };
}

export type { LinearWorkspaceDraftAssociation, LinearWorkspacePlanInput };
