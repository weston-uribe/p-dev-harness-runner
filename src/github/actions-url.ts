export function getGitHubActionsRunUrl(): string | null {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!serverUrl || !repository || !runId) {
    return null;
  }
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

export function formatGitHubActionsRunLink(url: string): string {
  return `[GitHub Actions run](${url})`;
}
