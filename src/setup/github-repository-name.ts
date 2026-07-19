const GITHUB_REPOSITORY_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

const RESERVED_REPOSITORY_NAMES = new Set([
  "settings",
  "admin",
  "root",
  "api",
  "www",
  "mail",
  "support",
  "help",
  "status",
  "security",
]);

export function normalizeGitHubRepositoryName(name: string): string {
  return name.trim();
}

export function validateGitHubRepositoryName(
  name: string,
): { ok: true; normalized: string } | { ok: false; reason: string } {
  const normalized = normalizeGitHubRepositoryName(name);
  if (!normalized) {
    return { ok: false, reason: "Repository name is required." };
  }
  if (normalized.length > 100) {
    return { ok: false, reason: "Repository name must be 100 characters or fewer." };
  }
  if (!GITHUB_REPOSITORY_NAME_PATTERN.test(normalized)) {
    return {
      ok: false,
      reason:
        "Repository name may only contain letters, numbers, dots, underscores, and hyphens.",
    };
  }
  if (normalized.startsWith(".") || normalized.endsWith(".")) {
    return {
      ok: false,
      reason: "Repository name cannot start or end with a dot.",
    };
  }
  if (normalized.includes("..")) {
    return { ok: false, reason: "Repository name cannot contain consecutive dots." };
  }
  if (RESERVED_REPOSITORY_NAMES.has(normalized.toLowerCase())) {
    return { ok: false, reason: "Repository name is reserved." };
  }
  return { ok: true, normalized };
}

export function validateRepositoryOwnerMatchesActor(
  owner: string,
  actorLogin: string,
): { ok: true } | { ok: false; reason: string } {
  if (owner.trim().toLowerCase() !== actorLogin.trim().toLowerCase()) {
    return {
      ok: false,
      reason: "Repository owner must match the authenticated GitHub user.",
    };
  }
  return { ok: true };
}
