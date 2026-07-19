import { LinearClient } from "@linear/sdk";
import type { LinearIssueSnapshot } from "./client.js";

export interface LinearIssueListItem {
  id: string;
  identifier: string;
  title: string;
  status: string | null;
  projectId: string | null;
  projectName: string | null;
  teamId: string | null;
  url: string | null;
}

export async function listIssuesByStatus(
  client: LinearClient,
  teamId: string,
  statusName: string,
  projectNames?: string[],
): Promise<LinearIssueListItem[]> {
  const team = await client.team(teamId);
  if (!team) {
    throw new Error(`Linear team not found: ${teamId}`);
  }

  const normalizedStatus = statusName.trim().toLowerCase();
  const connection = await team.issues({ first: 100 });
  const nodes = connection.nodes ?? [];
  const results: LinearIssueListItem[] = [];

  for (const issue of nodes) {
    const [state, project] = await Promise.all([issue.state, issue.project]);
    const issueStatus = state?.name ?? null;
    if (issueStatus?.trim().toLowerCase() !== normalizedStatus) {
      continue;
    }
    const projectName = project?.name ?? null;
    if (
      projectNames &&
      projectNames.length > 0 &&
      (!projectName || !projectNames.includes(projectName))
    ) {
      continue;
    }
    results.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issueStatus,
      projectId: project?.id ?? null,
      projectName,
      teamId: team.id,
      url: issue.url ?? null,
    });
  }

  return results;
}

export function toIssueSnapshot(item: LinearIssueListItem): LinearIssueSnapshot {
  return {
    id: item.id,
    identifier: item.identifier,
    title: item.title,
    description: null,
    status: item.status,
    projectId: item.projectId,
    projectName: item.projectName,
    teamName: null,
    teamKey: null,
    teamId: item.teamId,
    url: item.url,
  };
}
