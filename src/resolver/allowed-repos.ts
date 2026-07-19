import type { HarnessConfig } from "../config/types.js";
import { ResolverError } from "./errors.js";
import { normalizeRepoUrl } from "./normalize-repo.js";

export function assertRepoAllowed(
  targetRepo: string,
  config: HarnessConfig,
): void {
  const normalized = normalizeRepoUrl(targetRepo);
  const allowed = config.allowedTargetRepos.map((url) => normalizeRepoUrl(url));

  if (!allowed.includes(normalized)) {
    throw new ResolverError(
      "unknown_repo_denied",
      `Target repo "${normalized}" is not in allowedTargetRepos`,
    );
  }
}
