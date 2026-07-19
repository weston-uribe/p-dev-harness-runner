import type { LocalConfigFormInput } from "./config-local-editor.js";

export function deriveRepoConfigIdFromUrl(targetRepo: string): string {
  const trimmed = targetRepo.trim();
  const match = trimmed.match(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+)\/?$/,
  );
  return match?.[1] ?? "";
}

export function deriveUniqueRepoConfigIds(
  repos: Array<{ id: string; targetRepo: string }>,
): string[] {
  const used = new Set<string>();
  const ids: string[] = [];

  for (const repo of repos) {
    const manualId = repo.id.trim();
    const baseId =
      manualId || deriveRepoConfigIdFromUrl(repo.targetRepo) || "target-repo";

    let candidate = baseId;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }

    used.add(candidate);
    ids.push(candidate);
  }

  return ids;
}

export function prepareGuidedConfigFormInput(
  input: LocalConfigFormInput,
): LocalConfigFormInput {
  if (!input.repos.length) {
    return input;
  }

  const derivedIds = deriveUniqueRepoConfigIds(input.repos);

  return {
    ...input,
    repos: input.repos.map((repo, index) => ({
      ...repo,
      id: derivedIds[index] ?? repo.id,
    })),
  };
}
