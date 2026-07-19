/**
 * Resolve the set of Linear team keys the Vercel webhook bridge should accept.
 * Multi-association workspaces (e.g. TT + FRE) must all be allowlisted.
 */
export function parseHarnessTeamKeys(
  value: string | null | undefined,
): string[] {
  if (!value?.trim()) {
    return [];
  }
  return [
    ...new Set(
      value
        .split(/[,\s]+/)
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

export function issueKeyMatchesHarnessTeamKeys(
  issueKey: string,
  teamKeys: string[],
): boolean {
  if (teamKeys.length === 0) {
    return true;
  }
  const normalized = issueKey.trim().toUpperCase();
  return teamKeys.some((key) => normalized.startsWith(`${key}-`));
}

export function deriveHarnessTeamKeys(input: {
  linearTeamKey?: string | null;
  workspaceTeamKeys?: Array<string | null | undefined>;
  associationTeamKeys?: Array<string | null | undefined>;
}): string {
  const keys = new Set<string>();
  for (const candidate of [
    input.linearTeamKey,
    ...(input.workspaceTeamKeys ?? []),
    ...(input.associationTeamKeys ?? []),
  ]) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      keys.add(trimmed.toUpperCase());
    }
  }
  return [...keys].sort().join(",");
}
