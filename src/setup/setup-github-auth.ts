import { readExistingEnvFile } from "./env-merge.js";
import { resolveLocalFilePaths } from "./setup-state.js";

export async function loadGithubTokenFromEnvLocal(options?: {
  cwd?: string;
}): Promise<string | undefined> {
  const paths = resolveLocalFilePaths(options?.cwd);
  const existingEnv = await readExistingEnvFile(paths);
  const token = existingEnv?.values.GITHUB_TOKEN?.trim();
  return token || undefined;
}

export function hasGithubTokenConfigured(token?: string): boolean {
  return Boolean(token?.trim());
}
