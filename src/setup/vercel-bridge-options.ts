import { readControlPlaneSetupState } from "./control-plane-setup-state.js";
import { assessGitHubDispatchTokenEligibility } from "./github-dispatch-token.js";
import type { HarnessRepoProvisioningSummary } from "./harness-repo-provisioning.js";
import {
  listVercelProjects,
  listVercelTeams,
  type VercelProjectSummary,
  type VercelTeamSummary,
} from "./vercel-setup-client.js";

export interface VercelBridgeScopeOption {
  id: string;
  label: string;
  kind: "personal" | "team";
}

export interface VercelBridgeProjectOption {
  id: string;
  name: string;
  accountId?: string;
}

export interface VercelBridgeOptionsResult {
  scopes: VercelBridgeScopeOption[];
  projects: VercelBridgeProjectOption[];
  selectedScopeId?: string;
  selectedProjectId?: string;
  harnessTeamKey?: string;
  githubDispatch: Awaited<ReturnType<typeof assessGitHubDispatchTokenEligibility>>;
  capabilities: {
    teamCreate: boolean;
    projectCreate: boolean;
  };
  loadError?: string;
}

const PERSONAL_SCOPE_ID = "";

function scopeKey(teamId?: string): string {
  return teamId ?? PERSONAL_SCOPE_ID;
}

function toScopeOptions(teams: VercelTeamSummary[]): VercelBridgeScopeOption[] {
  return [
    { id: PERSONAL_SCOPE_ID, label: "Personal account (no team)", kind: "personal" },
    ...teams.map((team) => ({
      id: team.id,
      label: `${team.name} (${team.slug})`,
      kind: "team" as const,
    })),
  ];
}

function toProjectOptions(
  projects: VercelProjectSummary[],
): VercelBridgeProjectOption[] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    accountId: project.accountId,
  }));
}

function pickAutoSelection<T extends { id: string }>(
  options: T[],
  persistedId?: string,
): string | undefined {
  if (persistedId && options.some((option) => option.id === persistedId)) {
    return persistedId;
  }
  if (options.length === 1) {
    return options[0]?.id;
  }
  return undefined;
}

export async function loadVercelBridgeOptions(input: {
  vercelToken: string;
  githubToken?: string;
  cwd?: string;
  teamId?: string;
  harnessProvisioningSummary?: HarnessRepoProvisioningSummary;
}): Promise<VercelBridgeOptionsResult> {
  const controlPlane = await readControlPlaneSetupState(input.cwd);
  const harnessTeamKey = controlPlane?.linear?.teamKey;
  const githubDispatch = await assessGitHubDispatchTokenEligibility({
    githubToken: input.githubToken,
    cwd: input.cwd,
    harnessProvisioningSummary: input.harnessProvisioningSummary,
    requireVerifiedPackagedDispatchRepo: true,
  });

  const capabilities = {
    teamCreate: true,
    projectCreate: true,
  };

  if (!input.vercelToken.trim()) {
    return {
      scopes: [],
      projects: [],
      harnessTeamKey,
      githubDispatch,
      capabilities,
      loadError: "VERCEL_TOKEN is required to load Vercel bridge options.",
    };
  }

  try {
    const teams = await listVercelTeams(input.vercelToken);
    const scopes = toScopeOptions(teams);
    const persistedScopeId = scopeKey(controlPlane?.vercel?.teamId);
    const requestedScopeId =
      input.teamId !== undefined ? scopeKey(input.teamId) : persistedScopeId;
    const selectedScopeId = scopes.some((scope) => scope.id === requestedScopeId)
      ? requestedScopeId
      : pickAutoSelection(scopes, persistedScopeId);

    const teamIdForProjects =
      selectedScopeId && selectedScopeId.length > 0
        ? selectedScopeId
        : undefined;
    const projects = toProjectOptions(
      await listVercelProjects(input.vercelToken, teamIdForProjects),
    );
    const selectedProjectId = pickAutoSelection(
      projects,
      controlPlane?.vercel?.projectId,
    );

    return {
      scopes,
      projects,
      selectedScopeId,
      selectedProjectId,
      harnessTeamKey,
      githubDispatch,
      capabilities,
    };
  } catch (error) {
    return {
      scopes: [],
      projects: [],
      harnessTeamKey,
      githubDispatch,
      capabilities,
      loadError:
        error instanceof Error
          ? error.message
          : "Failed to load Vercel bridge options.",
    };
  }
}

export async function loadVercelBridgeProjectsForScope(input: {
  vercelToken: string;
  teamId?: string;
}): Promise<VercelBridgeProjectOption[]> {
  const projects = await listVercelProjects(
    input.vercelToken,
    input.teamId?.trim() ? input.teamId : undefined,
  );
  return toProjectOptions(projects);
}
