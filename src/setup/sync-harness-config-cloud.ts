import {
  fingerprintHarnessConfigBytes,
  HARNESS_CONFIG_FINGERPRINT_VARIABLE,
} from "../config/cloud-config-fingerprint.js";
import { harnessConfigSchema } from "../config/schema.js";
import { formatHarnessConfigJson } from "./config-builder.js";
import {
  generateHarnessConfigJsonB64,
  readValidatedConfigLocalBytes,
} from "./harness-secret-setup.js";
import { formatHarnessDispatchRepo, resolveHarnessDispatchRepo } from "./harness-dispatch-repo.js";
import { sanitizeGitHubSetupError } from "./github-remote-setup-live.js";
import type { GitHubRemoteSetupProvider } from "./github-remote-provider.js";

/**
 * Canonical cloud pair: same serialization + fingerprint function the runner
 * uses for cloud_config_stale (formatHarnessConfigJson + fingerprintHarnessConfigBytes).
 */
export async function buildCanonicalCloudConfigPair(cwd?: string): Promise<{
  bytes: Buffer;
  encodedValue: string;
  fingerprint: string;
}> {
  const { bytes: rawBytes } = await readValidatedConfigLocalBytes(cwd);
  const parsed = harnessConfigSchema.parse(
    JSON.parse(rawBytes.toString("utf8")) as unknown,
  );
  const bytes = Buffer.from(formatHarnessConfigJson(parsed), "utf8");
  const fingerprint = fingerprintHarnessConfigBytes(bytes);
  const encodedValue = generateHarnessConfigJsonB64(bytes);
  return { bytes, encodedValue, fingerprint };
}

const REMOTE_WRITE_MAX_ATTEMPTS = 3;
const REMOTE_WRITE_RETRY_MS = 500;

function isDefiniteRemoteRejection(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("404") ||
    message.includes("422") ||
    message.includes("bad credentials") ||
    message.includes("required for remote")
  );
}

async function writeRemoteWithRetry(input: {
  provider: GitHubRemoteSetupProvider;
  harnessRepository: string;
  write: () => Promise<void>;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REMOTE_WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await input.write();
      return;
    } catch (error) {
      lastError = error;
      if (isDefiniteRemoteRejection(error)) {
        throw error;
      }
      if (attempt < REMOTE_WRITE_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, REMOTE_WRITE_RETRY_MS * attempt),
        );
      }
    }
  }
  throw lastError instanceof Error
    ? new Error(sanitizeGitHubSetupError(lastError))
    : new Error("Remote harness config sync result is uncertain after retries.");
}

/**
 * Writes HARNESS_CONFIG_JSON_B64 then HARNESS_CONFIG_FINGERPRINT (last).
 * Does not record fully synchronized evidence — callers mark that after canary.
 */
export async function syncHarnessConfigCloudPair(input: {
  cwd?: string;
  provider: GitHubRemoteSetupProvider;
  harnessRepository?: string;
}): Promise<{ fingerprint: string; harnessRepository: string }> {
  const { encodedValue, fingerprint } = await buildCanonicalCloudConfigPair(
    input.cwd,
  );

  let harnessRepository = input.harnessRepository;
  if (!harnessRepository) {
    const harnessDispatchRepo = await resolveHarnessDispatchRepo({ cwd: input.cwd });
    if (!harnessDispatchRepo.resolved || !harnessDispatchRepo.repo) {
      throw new Error("Harness dispatch repository is not configured.");
    }
    harnessRepository = formatHarnessDispatchRepo(harnessDispatchRepo);
  }

  if (!input.provider.writeHarnessVariables) {
    throw new Error(
      "GitHub provider must support repository variable writes for HARNESS_CONFIG_FINGERPRINT",
    );
  }

  await writeRemoteWithRetry({
    provider: input.provider,
    harnessRepository,
    write: async () => {
      await input.provider.writeHarnessSecrets(harnessRepository, [
        { name: "HARNESS_CONFIG_JSON_B64", value: encodedValue },
      ]);
    },
  });

  await writeRemoteWithRetry({
    provider: input.provider,
    harnessRepository,
    write: async () => {
      await input.provider.writeHarnessVariables!(harnessRepository, [
        { name: HARNESS_CONFIG_FINGERPRINT_VARIABLE, value: fingerprint },
      ]);
    },
  });

  return { fingerprint, harnessRepository };
}
