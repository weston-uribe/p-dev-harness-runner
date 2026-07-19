import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactSecretsString } from "../artifacts/redact.js";

export const GIT_ASKPASS_TEMP_PREFIX = "p-dev-git-askpass-";

export interface GitAskpassCredentials {
  root: string;
  askpassPath: string;
  tokenPath: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

/**
 * Creates a temporary GIT_ASKPASS helper that reads the token from a 0600 file.
 * The token is never placed in the remote URL or git command argv.
 */
export async function createGitAskpassCredentials(
  token: string,
): Promise<GitAskpassCredentials> {
  const root = await mkdtemp(path.join(tmpdir(), GIT_ASKPASS_TEMP_PREFIX));
  const tokenPath = path.join(root, "token");
  const askpassPath = path.join(root, "askpass.sh");

  await writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  await chmod(tokenPath, 0o600);

  const script = `#!/bin/sh
set -eu
case "$1" in
  *Username*)
    printf '%s\\n' "x-access-token"
    ;;
  *)
    cat "$P_DEV_GIT_ASKPASS_TOKEN_FILE"
    ;;
esac
`;
  await writeFile(askpassPath, script, { encoding: "utf8", mode: 0o700 });
  await chmod(askpassPath, 0o700);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    P_DEV_GIT_ASKPASS_TOKEN_FILE: tokenPath,
  };
  // Prevent credential helper leakage into logs via nested helpers.
  delete env.GIT_CONFIG_PARAMETERS;

  return {
    root,
    askpassPath,
    tokenPath,
    env,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function redactGitSubprocessOutput(value: string): string {
  return redactSecretsString(value);
}

export function assertNoTokenLeak(input: {
  token: string;
  surfaces: Array<string | undefined | null>;
}): void {
  for (const surface of input.surfaces) {
    if (!surface) {
      continue;
    }
    if (surface.includes(input.token)) {
      throw new Error("Git credential token leaked into a captured surface.");
    }
  }
}
