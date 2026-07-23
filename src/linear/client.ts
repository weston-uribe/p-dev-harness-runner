import { LinearClient } from "@linear/sdk";

export interface LinearIssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  status: string | null;
  statusId?: string | null;
  labels?: Array<{ id: string; name: string }>;
  projectId: string | null;
  projectName: string | null;
  teamName: string | null;
  teamKey: string | null;
  teamId: string | null;
  url: string | null;
}

/** Derive Linear team key from issue identifier (e.g. FRE-1 → FRE). */
export function teamKeyFromIssueIdentifier(identifier: string): string | null {
  const match = identifier.trim().match(/^([A-Za-z][A-Za-z0-9]*)-\d+$/);
  return match?.[1] ?? null;
}

export async function fetchLinearIssue(
  issueKey: string,
  apiKey: string,
): Promise<LinearIssueSnapshot> {
  const client = new LinearClient({ apiKey });
  const issue = await client.issue(issueKey);

  if (!issue) {
    throw new Error(`Linear issue not found: ${issueKey}`);
  }

  const [state, project, team, labelsConnection] = await Promise.all([
    issue.state,
    issue.project,
    issue.team,
    issue.labels(),
  ]);

  const labels = (labelsConnection.nodes ?? []).map((label) => ({
    id: label.id,
    name: label.name ?? "",
  }));

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    status: state?.name ?? null,
    statusId: state?.id ?? null,
    labels,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    teamName: team?.name ?? null,
    teamKey: team?.key ?? teamKeyFromIssueIdentifier(issue.identifier),
    teamId: team?.id ?? null,
    url: issue.url ?? null,
  };
}

export async function pingLinear(apiKey: string): Promise<string> {
  const client = new LinearClient({ apiKey });
  const viewer = await client.viewer;
  return viewer.name ?? viewer.email ?? viewer.id;
}
