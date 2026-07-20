import {
  getVercelDeployment,
  listVercelProjects,
  listVercelTeams,
  VERCEL_API_BASE,
  type VercelDeploymentSummary,
} from "../setup/vercel-setup-client.js";
import type { GitHubClient } from "../github/client.js";
import { parseGitHubRepoUrl } from "../github/base-branch.js";
import {
  isCommitAncestorOf,
  isCommitReachableFromBranch,
} from "../github/commit-reachability.js";

export interface ProductionDeploymentVerificationSuccess {
  verified: true;
  deploymentId: string;
  deploymentSha: string;
  deploymentUrl: string;
  aliasSha: string;
  readyState: string;
  provider: "vercel";
}

export interface ProductionDeploymentVerificationFailure {
  verified: false;
  reason: string;
  deploymentId?: string;
  deploymentSha?: string;
}

export type ProductionDeploymentVerificationResult =
  | ProductionDeploymentVerificationSuccess
  | ProductionDeploymentVerificationFailure;

interface VercelDeploymentWithMeta extends VercelDeploymentSummary {
  githubCommitSha?: string;
  target?: string | null;
}

async function vercelFetchRaw<T>(
  token: string,
  path: string,
  teamId?: string,
): Promise<T> {
  const url = new URL(`${VERCEL_API_BASE}${path}`);
  if (teamId) {
    url.searchParams.set("teamId", teamId);
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Vercel API ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function resolveVercelProjectForGithubRepo(input: {
  vercelToken: string;
  githubRepoSlug: string;
  teamId?: string;
}): Promise<{ projectId: string; teamId?: string; projectName: string } | null> {
  const teams = input.teamId
    ? [{ id: input.teamId, name: "", slug: "" }]
    : await listVercelTeams(input.vercelToken);
  const wanted = input.githubRepoSlug.trim().toLowerCase();

  for (const team of teams.length > 0 ? teams : [{ id: undefined as string | undefined }]) {
    const projects = await listVercelProjects(
      input.vercelToken,
      typeof team.id === "string" ? team.id : undefined,
    );
    for (const project of projects) {
      const repo = project.gitRepository?.repo?.trim().toLowerCase();
      if (repo === wanted) {
        return {
          projectId: project.id,
          teamId: typeof team.id === "string" ? team.id : project.accountId,
          projectName: project.name,
        };
      }
    }
  }
  return null;
}

export async function listProductionDeploymentsWithMeta(input: {
  vercelToken: string;
  projectId: string;
  teamId?: string;
  limit?: number;
}): Promise<VercelDeploymentWithMeta[]> {
  const limit = input.limit ?? 10;
  const params = new URLSearchParams({
    projectId: input.projectId,
    target: "production",
    limit: String(limit),
  });
  const data = await vercelFetchRaw<{
    deployments: Array<{
      uid: string;
      url: string;
      state: string;
      readyState?: string;
      alias?: string[];
      meta?: { githubCommitSha?: string };
      target?: string | null;
    }>;
  }>(
    input.vercelToken,
    `/v6/deployments?${params.toString()}`,
    input.teamId,
  );

  return (data.deployments ?? []).map((deployment) => ({
    id: deployment.uid,
    url: deployment.url,
    state: deployment.state,
    readyState: deployment.readyState,
    aliases: deployment.alias ?? [],
    githubCommitSha: deployment.meta?.githubCommitSha,
    target: deployment.target,
  }));
}

/**
 * Prove a Vercel production READY deployment serves a SHA that contains mergeToDevSha,
 * and that a production alias is attached (or equal/newer containing SHA).
 */
export async function verifyVercelProductionDeployment(input: {
  vercelToken: string;
  githubClient: GitHubClient;
  targetRepo: string;
  productionBranch: string;
  mergeToDevSha: string;
  productionHeadSha: string;
}): Promise<ProductionDeploymentVerificationResult> {
  const parsed = parseGitHubRepoUrl(input.targetRepo);
  if (!parsed) {
    return { verified: false, reason: "invalid_target_repo" };
  }
  const githubRepoSlug = `${parsed.owner}/${parsed.repo}`;

  const project = await resolveVercelProjectForGithubRepo({
    vercelToken: input.vercelToken,
    githubRepoSlug,
  });
  if (!project) {
    return { verified: false, reason: "vercel_project_not_found" };
  }

  const deployments = await listProductionDeploymentsWithMeta({
    vercelToken: input.vercelToken,
    projectId: project.projectId,
    teamId: project.teamId,
    limit: 15,
  });

  const ready = deployments.filter((deployment) => {
    const state = (deployment.readyState ?? deployment.state).toUpperCase();
    return state === "READY";
  });

  if (ready.length === 0) {
    return { verified: false, reason: "no_ready_production_deployment" };
  }

  for (const deployment of ready) {
    let deploymentSha = deployment.githubCommitSha;
    if (!deploymentSha) {
      const detailed = await getVercelDeployment(
        input.vercelToken,
        deployment.id,
        project.teamId,
      );
      const detailedWithMeta = await vercelFetchRaw<{
        meta?: { githubCommitSha?: string };
        alias?: string[];
        readyState?: string;
        state?: string;
        url: string;
      }>(
        input.vercelToken,
        `/v13/deployments/${deployment.id}`,
        project.teamId,
      );
      deploymentSha = detailedWithMeta.meta?.githubCommitSha;
      deployment.aliases = detailed.aliases ?? detailedWithMeta.alias ?? [];
    }

    if (!deploymentSha) {
      continue;
    }

    const containsMerge = await isCommitAncestorOf(
      input.githubClient,
      parsed.owner,
      parsed.repo,
      input.mergeToDevSha,
      deploymentSha,
    );

    if (!containsMerge) {
      continue;
    }

    // Alias must serve this deployment or a production head that still contains the merge.
    const aliasAttached =
      (deployment.aliases?.length ?? 0) > 0 ||
      deploymentSha.toLowerCase() === input.productionHeadSha.toLowerCase();

    const headStillContainsMerge = (
      await isCommitReachableFromBranch(
        input.githubClient,
        parsed.owner,
        parsed.repo,
        input.mergeToDevSha,
        input.productionBranch,
      )
    ).reachable;

    if (!aliasAttached && !headStillContainsMerge) {
      continue;
    }

    // Prefer equal/newer production head that contains the merge.
    if (!headStillContainsMerge) {
      return {
        verified: false,
        reason: "production_head_no_longer_contains_merge",
        deploymentId: deployment.id,
        deploymentSha,
      };
    }

    return {
      verified: true,
      deploymentId: deployment.id,
      deploymentSha,
      deploymentUrl: `https://${deployment.url}`,
      aliasSha: input.productionHeadSha,
      readyState: deployment.readyState ?? deployment.state,
      provider: "vercel",
    };
  }

  return {
    verified: false,
    reason: "no_ready_deployment_contains_merge",
  };
}
