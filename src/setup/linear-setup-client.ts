import { LinearClient } from "@linear/sdk";
import type { Connection } from "@linear/sdk";
import { HARNESS_WEBHOOK_RESOURCE_TYPES } from "../webhook/harness-webhook-resources.js";
import type { RequiredWorkflowStatus } from "./linear-status-contract.js";

export interface LinearTeamSummary {
  id: string;
  key: string;
  name: string;
}

export interface LinearProjectSummary {
  id: string;
  name: string;
  description?: string | null;
  /** Team IDs from `project.teams()` — not on the default Project list fragment. */
  teamIds: string[];
}

export interface LinearWorkflowStateSummary {
  id: string;
  name: string;
  type: string;
}

export interface LinearWebhookSummary {
  id: string;
  url: string;
  enabled: boolean;
  resourceTypes: string[];
  teamId?: string;
  secret?: string;
}

export interface LinearSetupCapabilities {
  teamCreate: boolean;
  projectCreate: boolean;
  workflowStateCreate: boolean;
  webhookCreate: boolean;
  webhookList: boolean;
}

export function createLinearSetupClient(apiKey: string): LinearClient {
  return new LinearClient({ apiKey: apiKey.trim() });
}

async function paginateConnection<T>(
  connection: Connection<T>,
): Promise<T[]> {
  while (connection.pageInfo?.hasNextPage) {
    await connection.fetchNext();
  }
  return connection.nodes ?? [];
}

/**
 * Linear's default `projects()` list fragment does not include team IDs.
 * Team association is loaded per project via `project.teams()`.
 */
async function resolveProjectTeamIds(
  project: { id: string; teams: () => Promise<Connection<{ id: string }>> },
): Promise<string[]> {
  try {
    const teamsConnection = await project.teams();
    return (teamsConnection.nodes ?? []).map((team) => team.id);
  } catch {
    return [];
  }
}

export async function listLinearTeams(
  client: LinearClient,
): Promise<LinearTeamSummary[]> {
  const connection = await client.teams();
  const teams = await paginateConnection(connection);
  return teams.map((team) => ({
    id: team.id,
    key: team.key ?? "",
    name: team.name ?? "",
  }));
}

export async function listLinearProjects(
  client: LinearClient,
): Promise<LinearProjectSummary[]> {
  const connection = await client.projects();
  const projects = await paginateConnection(connection);
  return Promise.all(
    projects.map(async (project) => ({
      id: project.id,
      name: project.name ?? "",
      description: project.description ?? null,
      teamIds: await resolveProjectTeamIds(project),
    })),
  );
}

export async function getLinearProject(
  client: LinearClient,
  projectId: string,
): Promise<LinearProjectSummary | null> {
  try {
    const project = await client.project(projectId);
    if (!project) {
      return null;
    }
    return {
      id: project.id,
      name: project.name ?? "",
      description: project.description ?? null,
      teamIds: await resolveProjectTeamIds(project),
    };
  } catch {
    return null;
  }
}

export async function updateLinearProjectDescription(
  client: LinearClient,
  projectId: string,
  description: string,
): Promise<void> {
  await client.updateProject(projectId, { description });
}

export async function listTeamWorkflowStates(
  client: LinearClient,
  teamId: string,
): Promise<LinearWorkflowStateSummary[]> {
  const connection = await client.workflowStates({
    filter: { team: { id: { eq: teamId } } },
  });
  const states = await paginateConnection(connection);
  return states.map((state) => ({
    id: state.id,
    name: state.name ?? "",
    type: state.type ?? "",
  }));
}

export async function listLinearWebhooks(
  client: LinearClient,
): Promise<LinearWebhookSummary[]> {
  const connection = await client.webhooks();
  const webhooks = await paginateConnection(connection);
  return webhooks.map((webhook) => ({
    id: webhook.id,
    url: webhook.url ?? "",
    enabled: webhook.enabled ?? false,
    resourceTypes: webhook.resourceTypes ?? [],
    teamId: webhook.teamId ?? undefined,
    secret: webhook.secret ?? undefined,
  }));
}

export async function createLinearTeam(
  client: LinearClient,
  input: { name: string; key: string; description?: string },
): Promise<LinearTeamSummary> {
  const payload = await client.createTeam({
    name: input.name,
    key: input.key,
    description: input.description,
  });
  const team = await payload.team;
  if (!team) {
    throw new Error("Linear team creation did not return a team");
  }
  return {
    id: team.id,
    key: team.key ?? input.key,
    name: team.name ?? input.name,
  };
}

export async function createLinearProject(
  client: LinearClient,
  input: { name: string; teamIds: string[]; description?: string },
): Promise<LinearProjectSummary> {
  const payload = await client.createProject({
    name: input.name,
    teamIds: input.teamIds,
    description: input.description,
  });
  const project = await payload.project;
  if (!project) {
    throw new Error("Linear project creation did not return a project");
  }
  return {
    id: project.id,
    name: project.name ?? input.name,
    teamIds: input.teamIds,
  };
}

export async function createLinearWorkflowState(
  client: LinearClient,
  input: {
    teamId: string;
    name: string;
    type: RequiredWorkflowStatus["category"];
    color?: string;
  },
): Promise<LinearWorkflowStateSummary> {
  const payload = await client.createWorkflowState({
    teamId: input.teamId,
    name: input.name,
    type: input.type,
    color: input.color ?? "#9CA3AF",
  });
  const state = await payload.workflowState;
  if (!state) {
    throw new Error("Linear workflow state creation did not return a state");
  }
  return {
    id: state.id,
    name: state.name ?? input.name,
    type: state.type ?? input.type,
  };
}

export function isDuplicateWorkflowStateError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /duplicate workflow state/i.test(message);
}

export async function updateLinearWorkflowState(
  client: LinearClient,
  input: {
    id: string;
    name?: string;
    color?: string;
    description?: string;
    position?: number;
  },
): Promise<LinearWorkflowStateSummary> {
  const payload = await client.updateWorkflowState(input.id, {
    name: input.name,
    color: input.color,
    description: input.description,
    position: input.position,
  });
  const state = await payload.workflowState;
  if (!state) {
    throw new Error("Linear workflow state update did not return a state");
  }
  return {
    id: state.id,
    name: state.name ?? input.name ?? "",
    type: state.type ?? "",
  };
}

export async function listIssueIdsForWorkflowState(input: {
  client: LinearClient;
  teamId: string;
  stateId: string;
}): Promise<string[]> {
  const connection = await input.client.issues({
    filter: {
      team: { id: { eq: input.teamId } },
      state: { id: { eq: input.stateId } },
    },
  });
  const issues = await paginateConnection(connection);
  return issues.map((issue) => issue.id);
}

export async function updateLinearIssueState(
  client: LinearClient,
  input: { issueId: string; stateId: string },
): Promise<void> {
  await client.updateIssue(input.issueId, { stateId: input.stateId });
}

export async function archiveLinearWorkflowState(
  client: LinearClient,
  stateId: string,
): Promise<void> {
  await client.archiveWorkflowState(stateId);
}

export async function createLinearIssueWebhook(
  client: LinearClient,
  input: { url: string; teamId?: string; label?: string; secret?: string },
): Promise<LinearWebhookSummary> {
  const payload = await client.createWebhook({
    url: input.url,
    label: input.label ?? "Harness webhook bridge",
    resourceTypes: [...HARNESS_WEBHOOK_RESOURCE_TYPES],
    teamId: input.teamId,
    allPublicTeams: input.teamId ? undefined : true,
    ...(input.secret ? { secret: input.secret } : {}),
  });
  const webhook = await payload.webhook;
  if (!webhook) {
    throw new Error("Linear webhook creation did not return a webhook");
  }
  const secret =
    typeof (webhook as { secret?: unknown }).secret === "string"
      ? ((webhook as { secret?: string }).secret ?? undefined)
      : input.secret;
  return {
    id: webhook.id,
    url: webhook.url ?? input.url,
    enabled: webhook.enabled ?? true,
    resourceTypes: webhook.resourceTypes ?? [...HARNESS_WEBHOOK_RESOURCE_TYPES],
    teamId: webhook.teamId ?? input.teamId,
    secret,
  };
}

export async function updateLinearIssueWebhook(
  client: LinearClient,
  input: {
    webhookId: string;
    url: string;
    secret: string;
    label?: string;
  },
): Promise<LinearWebhookSummary> {
  const payload = await client.updateWebhook(input.webhookId, {
    url: input.url,
    label: input.label ?? "Harness webhook bridge",
    resourceTypes: [...HARNESS_WEBHOOK_RESOURCE_TYPES],
    secret: input.secret,
    enabled: true,
  });
  const webhook = await payload.webhook;
  if (!webhook) {
    throw new Error("Linear webhook update did not return a webhook");
  }
  return {
    id: webhook.id,
    url: webhook.url ?? input.url,
    enabled: webhook.enabled ?? true,
    resourceTypes: webhook.resourceTypes ?? [...HARNESS_WEBHOOK_RESOURCE_TYPES],
    teamId: webhook.teamId ?? undefined,
    secret: webhook.secret ?? input.secret,
  };
}

export async function deleteLinearWebhook(
  client: LinearClient,
  webhookId: string,
): Promise<void> {
  await client.deleteWebhook(webhookId);
}

export async function getLinearOrganizationSummary(
  client: LinearClient,
): Promise<{ id: string; name: string }> {
  const organization = await client.organization;
  return {
    id: organization.id,
    name: organization.name?.trim() || "Linear workspace",
  };
}

export function getLinearSetupCapabilities(): LinearSetupCapabilities {
  return {
    teamCreate: true,
    projectCreate: true,
    workflowStateCreate: true,
    webhookCreate: true,
    webhookList: true,
  };
}
