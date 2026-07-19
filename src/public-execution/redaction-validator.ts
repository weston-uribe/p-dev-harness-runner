const PUBLIC_UNSAFE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> =
  [
    { pattern: /\b[A-Z]{2,5}-\d+\b/, reason: "Linear issue key" },
    { pattern: /github\.com/i, reason: "GitHub URL" },
    { pattern: /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/, reason: "owner/repo slug" },
    { pattern: /HARNESS_ISSUE_KEY/i, reason: "issue key env name" },
    { pattern: /runs\/[A-Z]{2,5}-\d+/i, reason: "issue-scoped run directory" },
    { pattern: /ghp_/i, reason: "GitHub token prefix" },
    { pattern: /github_pat_/i, reason: "GitHub PAT prefix" },
    { pattern: /sk-/i, reason: "Secret key prefix" },
    { pattern: /Bearer\s+/i, reason: "Bearer token" },
    { pattern: /pull\//i, reason: "Pull request URL" },
    { pattern: /\bPR\s*#?\d+\b/i, reason: "Pull request number" },
    { pattern: /\bfinding\s*:/i, reason: "Finding text" },
    {
      pattern: /\b(?:src|apps|tests|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+\b/,
      reason: "Source path",
    },
  ];

export class PublicationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationRejectedError";
  }
}

function findPublicSafetyViolation(text: string): string | null {
  for (const { pattern, reason } of PUBLIC_UNSAFE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return reason;
    }
  }
  return null;
}

export function isPublicSafe(text: string): boolean {
  return findPublicSafetyViolation(text) === null;
}

export function assertPublicSafe(text: string): void {
  const violation = findPublicSafetyViolation(text);
  if (violation) {
    throw new PublicationRejectedError(
      `Public execution output rejected: ${violation}.`,
    );
  }
}
