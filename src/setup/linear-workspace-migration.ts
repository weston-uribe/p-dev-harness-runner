import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { harnessConfigSchema } from "../config/schema.js";
import type { HarnessConfig, LinearAssociation } from "../config/types.js";
import {
  evidenceFromAssociations,
  hasLinearAssociationsInConfig,
  resolveLinearAssociationsFromConfig,
} from "../config/resolve-linear-workspace.js";
import {
  readControlPlaneSetupState,
  writeControlPlaneSetupState,
} from "./control-plane-setup-state.js";
import type {
  ControlPlaneSetupState,
  LinearWorkspaceEvidence,
  LinearWorkspaceSelection,
} from "./control-plane-types.js";
import { resolveLocalFilePaths } from "./setup-state.js";

export type LinearWorkspaceMigrationCandidate = {
  workspaceId: string;
  workspaceName: string;
  associations: Array<LinearAssociation & { targetRepo: string; repoConfigId: string }>;
  evidence: LinearWorkspaceEvidence;
  configPatch: HarnessConfig;
};

export type LinearWorkspaceMigrationInput = {
  cwd?: string;
  workspaceId?: string;
  workspaceName?: string;
};

export type LinearWorkspaceMigrationResult =
  | { status: "already_migrated"; fingerprint: string }
  | { status: "nothing_to_migrate" }
  | { status: "candidate"; candidate: LinearWorkspaceMigrationCandidate }
  | { status: "applied"; fingerprint: string; evidence: LinearWorkspaceEvidence };

function hashCommittedAssociations(config: HarnessConfig): string {
  const associations = resolveLinearAssociationsFromConfig(config).map(
    (association) => ({
      workspaceId: association.workspaceId,
      teamId: association.teamId,
      teamKey: association.teamKey,
      projectId: association.projectId,
      projectName: association.projectName,
      targetRepo: association.targetRepo,
      repoConfigId: association.repoConfigId,
    }),
  );
  return createHash("sha256")
    .update(JSON.stringify(associations))
    .digest("hex")
    .slice(0, 16);
}

export function computeLinearAssociationsFingerprint(
  config: HarnessConfig,
): string {
  return hashCommittedAssociations(config);
}

function findLegacyRepoForMigration(config: HarnessConfig): {
  repoIndex: number;
  projectName?: string;
  teamKey?: string;
} {
  for (let index = 0; index < config.repos.length; index += 1) {
    const repo = config.repos[index];
    const projectName = repo.linearProjects?.[0]?.trim();
    const teamKey = repo.linearTeams?.[0]?.trim() ?? config.linear?.teamKey?.trim();
    if (projectName || teamKey) {
      return { repoIndex: index, projectName, teamKey };
    }
  }
  return { repoIndex: 0 };
}

export function deriveLinearWorkspaceMigrationCandidate(input: {
  config: HarnessConfig;
  controlPlane: ControlPlaneSetupState | null;
  workspaceId: string;
  workspaceName: string;
}): LinearWorkspaceMigrationCandidate | null {
  if (hasLinearAssociationsInConfig(input.config)) {
    return null;
  }

  const legacy = input.controlPlane?.linear;
  const teamId =
    legacy?.teamId?.trim() ??
    input.config.linear?.teamId?.trim();
  const teamKey =
    legacy?.teamKey?.trim() ??
    input.config.linear?.teamKey?.trim();
  const projectId = legacy?.projectId?.trim();
  const projectName =
    legacy?.projectName?.trim() ??
    findLegacyRepoForMigration(input.config).projectName;

  if (!teamId || !teamKey || !projectId || !projectName) {
    return null;
  }

  const { repoIndex } = findLegacyRepoForMigration(input.config);
  const repo = input.config.repos[repoIndex];
  if (!repo) {
    return null;
  }

  const association: LinearAssociation & {
    targetRepo: string;
    repoConfigId: string;
  } = {
    workspaceId: input.workspaceId,
    teamId,
    teamKey,
    projectId,
    projectName,
    targetRepo: repo.targetRepo,
    repoConfigId: repo.id,
  };

  const associations = [association];
  const evidence = evidenceFromAssociations({
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    associations,
    appliedFingerprint: legacy?.appliedFingerprint,
    appliedAt: legacy?.appliedAt,
    migratedFromVersion: "singular-linear-selection",
    migratedAt: new Date().toISOString(),
  });

  if (legacy?.statusCoverageComplete) {
    evidence.teams = evidence.teams.map((team) =>
      team.teamId === teamId
        ? {
            ...team,
            health: "healthy",
            lastVerifiedAt: legacy.appliedAt,
            projects: team.projects.map((project) =>
              project.projectId === projectId
                ? {
                    ...project,
                    health: "healthy",
                    lastVerifiedAt: legacy.appliedAt,
                  }
                : project,
            ),
          }
        : team,
    );
  }

  const nextRepos = input.config.repos.map((entry, index) =>
    index === repoIndex
      ? {
          ...entry,
          linearAssociations: [association],
        }
      : entry,
  );

  const configPatch = harnessConfigSchema.parse({
    ...input.config,
    linear: {
      ...input.config.linear,
      workspaceId: input.workspaceId,
      teamKey,
      teamId,
    },
    repos: nextRepos,
  });

  return {
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    associations,
    evidence,
    configPatch,
  };
}

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

export async function inspectLinearWorkspaceMigration(
  input: LinearWorkspaceMigrationInput = {},
): Promise<LinearWorkspaceMigrationResult> {
  const config = await readHarnessConfigLocal(input.cwd);
  if (!config) {
    return { status: "nothing_to_migrate" };
  }

  if (hasLinearAssociationsInConfig(config)) {
    return {
      status: "already_migrated",
      fingerprint: computeLinearAssociationsFingerprint(config),
    };
  }

  const controlPlane = await readControlPlaneSetupState(input.cwd);
  const workspaceId = input.workspaceId?.trim();
  const workspaceName = input.workspaceName?.trim();

  if (!workspaceId || !workspaceName) {
    return { status: "nothing_to_migrate" };
  }

  const candidate = deriveLinearWorkspaceMigrationCandidate({
    config,
    controlPlane,
    workspaceId,
    workspaceName,
  });

  if (!candidate) {
    return { status: "nothing_to_migrate" };
  }

  return { status: "candidate", candidate };
}

let migrationLock: Promise<void> = Promise.resolve();

export async function applyLinearWorkspaceMigration(
  input: LinearWorkspaceMigrationInput & {
    candidate: LinearWorkspaceMigrationCandidate;
  },
): Promise<LinearWorkspaceMigrationResult> {
  const run = async (): Promise<LinearWorkspaceMigrationResult> => {
    const currentConfig = await readHarnessConfigLocal(input.cwd);
    if (!currentConfig) {
      return { status: "nothing_to_migrate" };
    }

    if (hasLinearAssociationsInConfig(currentConfig)) {
      return {
        status: "already_migrated",
        fingerprint: computeLinearAssociationsFingerprint(currentConfig),
      };
    }

    await writeHarnessConfigLocal({
      cwd: input.cwd,
      config: input.candidate.configPatch,
    });

    const controlPlane = (await readControlPlaneSetupState(input.cwd)) ?? {
      version: 1 as const,
    };

    const nextState: ControlPlaneSetupState = {
      ...controlPlane,
      version: 1,
      linearWorkspace: input.candidate.evidence,
    };

    await writeControlPlaneSetupState(nextState, input.cwd);

    const fingerprint = computeLinearAssociationsFingerprint(
      input.candidate.configPatch,
    );

    return {
      status: "applied",
      fingerprint,
      evidence: input.candidate.evidence,
    };
  };

  const previous = migrationLock;
  let releaseLock!: () => void;
  migrationLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previous;
  try {
    return await run();
  } finally {
    releaseLock();
  }
}

export function isLegacyLinearWorkspaceSelection(
  value: LinearWorkspaceSelection | undefined,
): boolean {
  return Boolean(value?.teamKey?.trim() && value?.projectName?.trim());
}
