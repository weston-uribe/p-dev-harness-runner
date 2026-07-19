import { parsePrUrl } from "./pr-url.js";

export function parsePullRequestNumber(prUrl: string): number | null {
  return parsePrUrl(prUrl)?.pullNumber ?? null;
}

export function formatPullRequestLink(prUrl: string): string {
  const number = parsePullRequestNumber(prUrl);
  const label = number ? `Pull request #${number}` : "Pull request";
  return `[${label}](${prUrl})`;
}

export function formatCommitLink(
  targetRepo: string,
  mergeCommitSha: string,
): string {
  const normalized = targetRepo.replace(/\/$/, "");
  return `[Merge commit](${normalized}/commit/${mergeCommitSha})`;
}

export function formatMarkdownLink(label: string, url: string): string {
  return `[${label}](${url})`;
}
