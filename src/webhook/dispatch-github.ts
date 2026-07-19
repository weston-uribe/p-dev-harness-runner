import type { DispatchGitHubOptions } from "./types.js";

const DEFAULT_REPOSITORY = "weston-uribe/agentic-product-development-harness";
const DEFAULT_EVENT_TYPE = "linear_issue_status_changed";

export function getDispatchRepository(): string {
  return process.env.GITHUB_DISPATCH_REPOSITORY ?? DEFAULT_REPOSITORY;
}

export function getDispatchEventType(): string {
  return process.env.GITHUB_DISPATCH_EVENT_TYPE ?? DEFAULT_EVENT_TYPE;
}

export function buildRepositoryDispatchUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/dispatches`;
}

export async function dispatchRepositoryEvent(
  options: DispatchGitHubOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildRepositoryDispatchUrl(options.repository);

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: options.eventType,
      client_payload: options.clientPayload,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `GitHub repository_dispatch failed (${response.status}): ${detail.slice(0, 200)}`,
    );
  }
}
