import {
  issueKeyMatchesHarnessTeamKeys,
  parseHarnessTeamKeys,
} from "../setup/harness-team-keys.js";

const ISSUE_KEY_FROM_URL = /\/([A-Z]+-\d+)(?:\/|$|#)/;

export function extractIssueKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const match = url.match(ISSUE_KEY_FROM_URL);
  return match?.[1] ?? null;
}

export interface ExtractIssueKeyOptions {
  identifier?: string | null;
  issueUrl?: string | null;
  payloadUrl?: string | null;
  teamKey?: string | null;
}

export function extractIssueKey(options: ExtractIssueKeyOptions): string | null {
  const fromIdentifier =
    typeof options.identifier === "string" && options.identifier.trim() !== ""
      ? options.identifier.trim()
      : null;

  if (fromIdentifier) {
    return validateIssueKeyTeam(fromIdentifier, options.teamKey)
      ? fromIdentifier
      : null;
  }

  for (const url of [options.payloadUrl, options.issueUrl]) {
    const fromUrl = extractIssueKeyFromUrl(url);
    if (fromUrl && validateIssueKeyTeam(fromUrl, options.teamKey)) {
      return fromUrl;
    }
  }

  return null;
}

export function validateIssueKeyTeam(
  issueKey: string,
  teamKey: string | null | undefined,
): boolean {
  return issueKeyMatchesHarnessTeamKeys(
    issueKey,
    parseHarnessTeamKeys(teamKey),
  );
}
