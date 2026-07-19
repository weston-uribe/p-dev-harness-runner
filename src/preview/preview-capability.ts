/**
 * Application preview capture (target-repo PR / production deployment polling)
 * is separate from the PDev automation bridge hosted on Vercel.
 */
export function shouldCaptureApplicationPreview(
  previewProvider: string | undefined | null,
): boolean {
  const normalized = previewProvider?.trim().toLowerCase();
  return normalized !== undefined && normalized !== "" && normalized !== "none";
}

export function allReposSkipApplicationPreview(
  repos: Array<{ previewProvider?: string }> | undefined,
): boolean {
  if (!repos?.length) {
    return false;
  }
  return repos.every(
    (repo) => !shouldCaptureApplicationPreview(repo.previewProvider),
  );
}
