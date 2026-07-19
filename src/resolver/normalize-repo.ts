const GITHUB_HTTPS_PREFIX = "https://github.com/";
const GITHUB_HOST_PREFIX = "github.com/";

export function normalizeRepoUrl(input: string): string {
  const trimmed = input.trim().replace(/\/$/, "");

  if (trimmed.startsWith(GITHUB_HTTPS_PREFIX)) {
    return trimmed;
  }

  if (trimmed.startsWith("http://github.com/")) {
    return `${GITHUB_HTTPS_PREFIX}${trimmed.slice("http://github.com/".length)}`;
  }

  if (trimmed.startsWith(GITHUB_HOST_PREFIX)) {
    return `${GITHUB_HTTPS_PREFIX}${trimmed.slice(GITHUB_HOST_PREFIX.length)}`;
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `${GITHUB_HTTPS_PREFIX}${trimmed}`;
  }

  return trimmed;
}

export function repoUrlsEquivalent(a: string, b: string): boolean {
  return normalizeRepoUrl(a) === normalizeRepoUrl(b);
}

export function isValidGithubRepoUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url);
}
