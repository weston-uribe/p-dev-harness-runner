export interface ParsedPrUrl {
  owner: string;
  repo: string;
  pullNumber: number;
  repoUrl: string;
}

export function parsePrUrl(prUrl: string): ParsedPrUrl | null {
  const match = prUrl.trim().match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/,
  );
  if (!match) {
    return null;
  }
  const owner = match[1];
  const repo = match[2];
  return {
    owner,
    repo,
    pullNumber: Number.parseInt(match[3], 10),
    repoUrl: `https://github.com/${owner}/${repo}`,
  };
}
