import {
  REQUIRED_VERCEL_BRIDGE_ENV_VARS,
  type OptionalVercelBridgeEnvVarName,
  type VercelBridgeEnvVarName,
} from "./vercel-bridge-readiness.js";

export const VERCEL_API_BASE = "https://api.vercel.com";

export type VercelEnvVarType =
  | "system"
  | "encrypted"
  | "plain"
  | "sensitive"
  | "secret";

export interface VercelUserSummary {
  id: string;
  username: string;
  email?: string;
}

export interface VercelTeamSummary {
  id: string;
  name: string;
  slug: string;
}

export interface VercelProjectSummary {
  id: string;
  name: string;
  accountId?: string;
  gitRepository?: VercelGitRepository;
}

export interface VercelEnvVarSummary {
  id?: string;
  key: string;
  target: string[];
  type: string;
}

export interface VercelDeploymentSummary {
  id: string;
  url: string;
  state: string;
  readyState?: string;
  /** Production aliases assigned to this deployment (Vercel API `alias` field). */
  aliases?: string[];
}

export type VercelProductionUrlSource = "stable_alias" | "latest_ready_deployment";

export interface VercelGitRepository {
  type: "github";
  repo: string;
}

export interface VercelDeploymentFile {
  file: string;
  data: string;
  encoding?: "utf-8" | "base64";
}

export interface VercelProductionTarget {
  productionUrl: string;
  webhookUrl: string;
  deploymentId: string;
  deploymentUrl: string;
  source: VercelProductionUrlSource;
  stableAlias?: string;
  readyState?: string;
  state?: string;
}

export class VercelEnvVarTypeError extends Error {
  readonly key: string;
  readonly existingType?: string;
  readonly status: number;

  constructor(input: {
    key: string;
    existingType?: string;
    status: number;
    message: string;
  }) {
    super(input.message);
    this.name = "VercelEnvVarTypeError";
    this.key = input.key;
    this.existingType = input.existingType;
    this.status = input.status;
  }
}

export class VercelTeamBillingError extends Error {
  readonly status: number;
  readonly providerCode?: string;

  constructor(input: {
    status: number;
    providerCode?: string;
    message: string;
  }) {
    super(input.message);
    this.name = "VercelTeamBillingError";
    this.status = input.status;
    this.providerCode = input.providerCode;
  }
}

const SECRET_ENV_VAR_KEYS = new Set<VercelBridgeEnvVarName | OptionalVercelBridgeEnvVarName>([
  "LINEAR_WEBHOOK_SECRET",
  "GITHUB_DISPATCH_TOKEN",
]);

export function getDefaultEnvVarType(
  key: VercelBridgeEnvVarName | OptionalVercelBridgeEnvVarName,
): VercelEnvVarType {
  if (SECRET_ENV_VAR_KEYS.has(key)) {
    return "sensitive";
  }
  return "plain";
}

export function buildExistingEnvVarPatchBody(input: {
  value: string;
  existingEnv?: VercelEnvVarSummary;
}): { value: string; target: string[] } {
  return {
    value: input.value,
    target: input.existingEnv?.target?.length
      ? input.existingEnv.target
      : ["production"],
  };
}

function parseVercelEnvVarUpdateError(input: {
  key: string;
  existingType?: string;
  status: number;
  body: string;
}): VercelEnvVarTypeError | null {
  if (
    /cannot change the key of a sensitive environment variable/i.test(input.body)
  ) {
    return new VercelEnvVarTypeError({
      key: input.key,
      existingType: input.existingType,
      status: input.status,
      message:
        `Vercel rejected updating ${input.key} because sensitive environment variables cannot have their key changed via API. ` +
        "The app did not delete or recreate it. Update the value manually in Vercel or approve a separate delete/recreate repair.",
    });
  }

  if (
    /cannot change the type of a sensitive environment variable/i.test(input.body)
  ) {
    return new VercelEnvVarTypeError({
      key: input.key,
      existingType: input.existingType,
      status: input.status,
      message:
        `Vercel rejected updating ${input.key} because it is a sensitive environment variable whose type cannot be changed. ` +
        "The app did not delete or recreate it. Update the value manually in Vercel or approve a separate delete/recreate repair.",
    });
  }

  return null;
}

function parseVercelTeamBillingError(input: {
  status: number;
  body: string;
}): VercelTeamBillingError | null {
  const providerCodeMatch = input.body.match(
    /"code"\s*:\s*"(payment_method_required|billing|payment[^"]*)"/i,
  );
  const providerCode = providerCodeMatch?.[1];
  const billingRequired =
    providerCode === "payment_method_required" ||
    /payment method is required/i.test(input.body) ||
    /credit card/i.test(input.body);

  if (!billingRequired) {
    return null;
  }

  return new VercelTeamBillingError({
    status: input.status,
    providerCode: providerCode ?? "payment_method_required",
    message:
      "Vercel requires a payment method before creating another team. No harness setup was applied. Add or update billing in Vercel, or choose an existing team.",
  });
}

async function vercelFetch<T>(
  token: string,
  path: string,
  init?: RequestInit & { teamId?: string },
): Promise<T> {
  const url = new URL(`${VERCEL_API_BASE}${path}`);
  if (init?.teamId) {
    url.searchParams.set("teamId", init.teamId);
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Vercel API ${response.status} on ${path}: ${body.slice(0, 200)}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function verifyVercelToken(
  token: string,
): Promise<VercelUserSummary> {
  const data = await vercelFetch<{ user: VercelUserSummary }>(token, "/v2/user");
  return data.user;
}

export async function listVercelTeams(
  token: string,
): Promise<VercelTeamSummary[]> {
  const data = await vercelFetch<{
    teams: Array<{ id: string; name: string; slug: string }>;
  }>(token, "/v2/teams");
  return (data.teams ?? []).map((team) => ({
    id: team.id,
    name: team.name,
    slug: team.slug,
  }));
}

export async function createVercelTeam(
  token: string,
  input: { slug: string; name?: string },
): Promise<VercelTeamSummary> {
  const path = "/v1/teams";
  const url = new URL(`${VERCEL_API_BASE}${path}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slug: input.slug.trim(),
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const billingError = parseVercelTeamBillingError({
      status: response.status,
      body,
    });
    if (billingError) {
      throw billingError;
    }
    throw new Error(
      `Vercel API ${response.status} on ${path}: ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    id: string;
    slug: string;
    name?: string;
  };

  return {
    id: data.id,
    slug: data.slug,
    name: data.name ?? input.name?.trim() ?? data.slug,
  };
}

export async function listVercelProjects(
  token: string,
  teamId?: string,
): Promise<VercelProjectSummary[]> {
  const data = await vercelFetch<{
    projects: Array<{ id: string; name: string; accountId?: string }>;
  }>(token, "/v9/projects", { teamId });
  return (data.projects ?? []).map((project) => ({
    id: project.id,
    name: project.name,
    accountId: project.accountId,
  }));
}

export async function createVercelProject(
  token: string,
  input: { name: string; teamId?: string; gitRepository?: VercelGitRepository },
): Promise<VercelProjectSummary> {
  const data = await vercelFetch<{
    id: string;
    name: string;
    accountId?: string;
    gitRepository?: VercelGitRepository;
  }>(token, "/v11/projects", {
    method: "POST",
    teamId: input.teamId,
    body: JSON.stringify({
      name: input.name.trim(),
      ...(input.gitRepository ? { gitRepository: input.gitRepository } : {}),
    }),
  });

  return {
    id: data.id,
    name: data.name,
    accountId: data.accountId,
    gitRepository: data.gitRepository,
  };
}

export async function probeVercelGitRepositoryAccess(
  token: string,
  input: { repository: string; teamId?: string },
): Promise<{ accessible: boolean; reason?: string }> {
  const [owner] = input.repository.split("/");
  if (!owner) {
    return { accessible: false, reason: "invalid_repository" };
  }

  try {
    const data = await vercelFetch<{
      gitNamespaces?: Array<{ slug?: string; name?: string }>;
      namespaces?: Array<{ slug?: string; name?: string }>;
    }>(
      token,
      `/v1/integrations/git-namespaces?provider=github`,
      { teamId: input.teamId },
    );
    const namespaces = data.gitNamespaces ?? data.namespaces ?? [];
    const accessible = namespaces.some(
      (namespace) =>
        namespace.slug?.toLowerCase() === owner.toLowerCase() ||
        namespace.name?.toLowerCase() === owner.toLowerCase(),
    );
    return accessible
      ? { accessible: true }
      : { accessible: false, reason: "github_namespace_not_available_to_vercel" };
  } catch (error) {
    return {
      accessible: false,
      reason: error instanceof Error ? error.message : "git_access_probe_failed",
    };
  }
}

export async function createVercelDeployment(
  token: string,
  input: {
    projectName: string;
    teamId?: string;
    target?: "production";
    files?: VercelDeploymentFile[];
    projectSettings?: Record<string, unknown>;
  },
): Promise<VercelDeploymentSummary> {
  const data = await vercelFetch<{
    uid?: string;
    id?: string;
    url: string;
    state: string;
    readyState?: string;
    alias?: string[];
  }>(token, "/v13/deployments", {
    method: "POST",
    teamId: input.teamId,
    body: JSON.stringify({
      name: input.projectName.trim(),
      target: input.target ?? "production",
      ...(input.files ? { files: input.files } : {}),
      ...(input.projectSettings ? { projectSettings: input.projectSettings } : {}),
    }),
  });
  return {
    id: data.uid ?? data.id ?? "",
    url: data.url,
    state: data.state,
    readyState: data.readyState,
    aliases: data.alias ?? [],
  };
}

export async function listVercelProjectEnvVars(
  token: string,
  projectId: string,
  teamId?: string,
): Promise<VercelEnvVarSummary[]> {
  const data = await vercelFetch<{
    envs: Array<{ id?: string; key: string; target?: string[]; type?: string }>;
  }>(token, `/v9/projects/${projectId}/env`, { teamId });
  return (data.envs ?? []).map((env) => ({
    id: env.id,
    key: env.key,
    target: env.target ?? [],
    type: env.type ?? "encrypted",
  }));
}

export function isVercelDeploymentReady(
  deployment: Pick<VercelDeploymentSummary, "state" | "readyState">,
): boolean {
  return deployment.readyState === "READY" || deployment.state === "READY";
}

export function normalizeProductionHost(hostOrUrl: string): string {
  return hostOrUrl.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
}

/**
 * Vercel deployment-specific production hosts often look like
 * `{project}-{hash}-{team}.vercel.app` and change on every production deploy.
 */
export function isDeploymentSpecificVercelHost(host: string): boolean {
  const normalized = normalizeProductionHost(host);
  return /^.+-[a-z0-9]{8,}-.+\.vercel\.app$/i.test(normalized);
}

export function selectStableProductionHost(input: {
  deploymentUrl: string;
  aliases?: string[];
}): { host: string; source: VercelProductionUrlSource; stableAlias?: string } {
  const deploymentHost = normalizeProductionHost(input.deploymentUrl);
  const aliases = (input.aliases ?? [])
    .map((alias) => normalizeProductionHost(alias))
    .filter(Boolean);

  const stableAliases = aliases.filter(
    (alias) => alias !== deploymentHost && !isDeploymentSpecificVercelHost(alias),
  );

  if (stableAliases.length > 0) {
    const customDomain = stableAliases.find((alias) => !alias.endsWith(".vercel.app"));
    const chosen =
      customDomain ?? [...stableAliases].sort((left, right) => left.length - right.length)[0]!;
    return { host: chosen, source: "stable_alias", stableAlias: chosen };
  }

  const alternateAlias = aliases.find((alias) => alias !== deploymentHost);
  if (alternateAlias) {
    return {
      host: alternateAlias,
      source: "stable_alias",
      stableAlias: alternateAlias,
    };
  }

  return { host: deploymentHost, source: "latest_ready_deployment" };
}

export async function resolveCanonicalProductionTarget(input: {
  vercelToken: string;
  projectId: string;
  teamId?: string;
  preferredDeploymentId?: string;
  listDeployments?: typeof listVercelProductionDeployments;
  getDeployment?: typeof getVercelDeployment;
}): Promise<VercelProductionTarget | undefined> {
  const listDeployments =
    input.listDeployments ?? listVercelProductionDeployments;
  const getDeployment = input.getDeployment ?? getVercelDeployment;

  let deployment: VercelDeploymentSummary | undefined;

  if (input.preferredDeploymentId?.trim()) {
    deployment = await getDeployment(
      input.vercelToken,
      input.preferredDeploymentId.trim(),
      input.teamId,
    );
    if (!isVercelDeploymentReady(deployment)) {
      return undefined;
    }
  } else {
    const deployments = await listDeployments(
      input.vercelToken,
      input.projectId,
      input.teamId,
      { state: "READY", limit: 5 },
    );
    deployment = deployments.find((candidate) => isVercelDeploymentReady(candidate));
    if (!deployment) {
      return undefined;
    }
    if (!deployment.aliases?.length) {
      deployment = await getDeployment(
        input.vercelToken,
        deployment.id,
        input.teamId,
      );
    }
  }

  const selected = selectStableProductionHost({
    deploymentUrl: deployment.url,
    aliases: deployment.aliases,
  });

  return {
    productionUrl: `https://${selected.host}`,
    webhookUrl: buildWebhookUrl(selected.host),
    deploymentId: deployment.id,
    deploymentUrl: deployment.url,
    source: selected.source,
    stableAlias: selected.stableAlias,
    readyState: deployment.readyState,
    state: deployment.state,
  };
}

export async function listVercelProductionDeployments(
  token: string,
  projectId: string,
  teamId?: string,
  options?: { state?: string; limit?: number },
): Promise<VercelDeploymentSummary[]> {
  const limit = options?.limit ?? 5;
  const params = new URLSearchParams({
    projectId,
    target: "production",
    limit: String(limit),
  });
  if (options?.state?.trim()) {
    params.set("state", options.state.trim());
  }
  const data = await vercelFetch<{
    deployments: Array<{
      uid: string;
      url: string;
      state: string;
      readyState?: string;
      alias?: string[];
    }>;
  }>(token, `/v6/deployments?${params.toString()}`, {
    teamId,
  });
  return (data.deployments ?? []).map((deployment) => ({
    id: deployment.uid,
    url: deployment.url,
    state: deployment.state,
    readyState: deployment.readyState,
    aliases: deployment.alias ?? [],
  }));
}

export async function getVercelDeployment(
  token: string,
  deploymentId: string,
  teamId?: string,
): Promise<VercelDeploymentSummary> {
  const data = await vercelFetch<{
    uid?: string;
    id?: string;
    url: string;
    state: string;
    readyState?: string;
    alias?: string[];
  }>(token, `/v13/deployments/${deploymentId}`, { teamId });
  return {
    id: data.uid ?? data.id ?? deploymentId,
    url: data.url,
    state: data.state,
    readyState: data.readyState,
    aliases: data.alias ?? [],
  };
}

export async function triggerVercelProductionRedeploy(
  token: string,
  input: {
    projectName: string;
    sourceDeploymentId: string;
    teamId?: string;
  },
): Promise<VercelDeploymentSummary> {
  const data = await vercelFetch<{
    uid?: string;
    id?: string;
    url: string;
    state: string;
    readyState?: string;
  }>(token, "/v13/deployments", {
    method: "POST",
    teamId: input.teamId,
    body: JSON.stringify({
      name: input.projectName.trim(),
      deploymentId: input.sourceDeploymentId,
      target: "production",
    }),
  });
  return {
    id: data.uid ?? data.id ?? input.sourceDeploymentId,
    url: data.url,
    state: data.state,
    readyState: data.readyState,
  };
}

export async function upsertVercelProjectEnvVar(
  token: string,
  input: {
    projectId: string;
    teamId?: string;
    key: VercelBridgeEnvVarName | OptionalVercelBridgeEnvVarName | string;
    value: string;
    existingEnv?: VercelEnvVarSummary;
    existingEnvId?: string;
  },
): Promise<void> {
  const existingEnvId = input.existingEnv?.id ?? input.existingEnvId;
  const existingType = input.existingEnv?.type;
  const createType =
    input.key === "LINEAR_WEBHOOK_SECRET" ||
    input.key === "GITHUB_DISPATCH_TOKEN" ||
    input.key === "HARNESS_TEAM_KEY" ||
    input.key === "GITHUB_DISPATCH_REPOSITORY" ||
    input.key === "GITHUB_DISPATCH_EVENT_TYPE" ||
    input.key === "LINEAR_WEBHOOK_TIMESTAMP_TOLERANCE_MS"
      ? getDefaultEnvVarType(input.key)
      : "plain";

  if (existingEnvId) {
    const updateType = (existingType ?? "encrypted") as VercelEnvVarType;
    const path = `/v9/projects/${input.projectId}/env/${existingEnvId}`;
    const url = new URL(`${VERCEL_API_BASE}${path}`);
    if (input.teamId) {
      url.searchParams.set("teamId", input.teamId);
    }

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildExistingEnvVarPatchBody({
          value: input.value,
          existingEnv: input.existingEnv,
        }),
      ),
    });

    if (!response.ok) {
      const body = await response.text();
      const typedError = parseVercelEnvVarUpdateError({
        key: input.key,
        existingType: updateType,
        status: response.status,
        body,
      });
      if (typedError) {
        throw typedError;
      }
      throw new Error(
        `Vercel API ${response.status} on ${path}: ${body.slice(0, 200)}`,
      );
    }
    return;
  }

  const path = `/v10/projects/${input.projectId}/env`;
  const url = new URL(`${VERCEL_API_BASE}${path}`);
  if (input.teamId) {
    url.searchParams.set("teamId", input.teamId);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key: input.key,
      value: input.value,
      type: createType,
      target: ["production"],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const typedError = parseVercelEnvVarUpdateError({
      key: input.key,
      existingType: createType,
      status: response.status,
      body,
    });
    if (typedError) {
      throw typedError;
    }
    throw new Error(
      `Vercel API ${response.status} on ${path}: ${body.slice(0, 200)}`,
    );
  }
}

export async function checkWebhookEndpointReachable(
  webhookUrl: string,
): Promise<{ reachable: boolean; statusCode?: number; reason?: string }> {
  try {
    const response = await fetch(webhookUrl, { method: "GET", redirect: "manual" });
    const location = response.headers.get("location") ?? "";
    if (
      (response.status === 302 ||
        response.status === 307 ||
        response.status === 308) &&
      /vercel\.com\/sso-api/i.test(location)
    ) {
      return {
        reachable: false,
        statusCode: response.status,
        reason: "protection_redirect",
      };
    }
    if (response.status === 405) {
      return { reachable: true, statusCode: response.status };
    }
    if (
      response.status === 404 ||
      response.status === 401 ||
      response.status === 403
    ) {
      return { reachable: false, statusCode: response.status };
    }
    if (response.status >= 500) {
      return { reachable: false, statusCode: response.status };
    }
    if (response.status >= 200 && response.status < 400) {
      return { reachable: true, statusCode: response.status };
    }
    return { reachable: false, statusCode: response.status };
  } catch {
    return { reachable: false };
  }
}

export function buildWebhookUrl(productionDomain: string): string {
  const normalized = productionDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${normalized}/api/linear-webhook`;
}

export function summarizeRequiredEnvPresence(
  envVars: VercelEnvVarSummary[],
): Record<VercelBridgeEnvVarName, "present" | "missing"> {
  const keys = new Set(envVars.map((env) => env.key));
  return Object.fromEntries(
    REQUIRED_VERCEL_BRIDGE_ENV_VARS.map((name) => [
      name,
      keys.has(name) ? "present" : "missing",
    ]),
  ) as Record<VercelBridgeEnvVarName, "present" | "missing">;
}

export function findExistingTeamBySlug(
  teams: VercelTeamSummary[],
  slug: string,
): VercelTeamSummary | undefined {
  const normalized = slug.trim().toLowerCase();
  return teams.find((team) => team.slug.toLowerCase() === normalized);
}

export function findExistingProjectByName(
  projects: VercelProjectSummary[],
  name: string,
): VercelProjectSummary | undefined {
  const normalized = name.trim().toLowerCase();
  return projects.find((project) => project.name.toLowerCase() === normalized);
}
