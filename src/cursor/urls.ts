const CURSOR_CLOUD_BASE_URL = "https://cursor.com/agents";

export function buildCursorCloudRunUrl(
  agentId: string,
  runId?: string | null,
): string {
  const url = new URL(`${CURSOR_CLOUD_BASE_URL}/${encodeURIComponent(agentId)}`);
  if (runId) {
    url.searchParams.set("run", runId);
  }
  return url.toString();
}

export function formatCursorCloudRunLink(
  agentId: string,
  runId?: string | null,
): string {
  return `[Cursor Cloud run](${buildCursorCloudRunUrl(agentId, runId)})`;
}
