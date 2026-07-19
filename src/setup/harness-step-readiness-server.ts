import { parseGitHubRepoSlug } from "./github-repo-slug.js";
import { readGitRemoteOrigin } from "./harness-dispatch-repo.js";

export type Step1HarnessRepoSource = "env-local" | "git-remote-origin";

export interface Step1TrustedHarnessRepo {
  repo: string;
  source: Step1HarnessRepoSource;
}

export async function resolveStep1TrustedHarnessRepo(options: {
  cwd?: string;
  explicitRepo?: string | null;
}): Promise<Step1TrustedHarnessRepo | null> {
  const explicit = options.explicitRepo?.trim();
  if (explicit) {
    const slug = parseGitHubRepoSlug(explicit);
    if (slug) {
      return { repo: slug, source: "env-local" };
    }
  }

  const gitRemote = await readGitRemoteOrigin(options.cwd);
  const suggested = gitRemote ? parseGitHubRepoSlug(gitRemote) : null;
  if (suggested) {
    return { repo: suggested, source: "git-remote-origin" };
  }

  return null;
}

export function step1TrustedHarnessRepoMessage(
  trusted: Step1TrustedHarnessRepo,
): string {
  if (trusted.source === "env-local") {
    return `Using harness workspace ${trusted.repo} from Step 1 setup.`;
  }
  return `Using harness workspace ${trusted.repo} detected from git remote.`;
}
