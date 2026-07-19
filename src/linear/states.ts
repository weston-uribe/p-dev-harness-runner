import { LinearClient } from "@linear/sdk";

export async function resolveWorkflowStateId(
  client: LinearClient,
  teamId: string,
  statusName: string,
): Promise<string> {
  const connection = await client.workflowStates({
    filter: { team: { id: { eq: teamId } } },
  });
  const nodes = connection.nodes ?? [];
  const normalized = statusName.trim().toLowerCase();
  const match = nodes.find((state) => state.name?.toLowerCase() === normalized);
  if (!match?.id) {
    throw new Error(
      `Workflow state "${statusName}" not found for team ${teamId}`,
    );
  }
  return match.id;
}
