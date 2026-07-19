export function parseGitHubRepoSlug(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const httpsMatch = trimmed.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  );
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = trimmed.match(
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  const slugMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (slugMatch) {
    return `${slugMatch[1]}/${slugMatch[2]}`;
  }

  return null;
}

export function parseGitRemoteOriginUrl(remoteUrl: string): string | null {
  return parseGitHubRepoSlug(remoteUrl);
}
