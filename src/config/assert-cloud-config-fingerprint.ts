import {
  checkCloudConfigFingerprint,
  HARNESS_CONFIG_FINGERPRINT_VARIABLE,
  shouldEnforceCloudConfigFingerprint,
} from "./cloud-config-fingerprint.js";

export class CloudConfigStaleError extends Error {
  readonly errorClassification = "cloud_config_stale" as const;

  constructor(message: string) {
    super(message);
    this.name = "CloudConfigStaleError";
  }
}

/**
 * Fail before routing/execution when the Actions secret and paired fingerprint
 * variable disagree. No-op outside GitHub Actions (or when skip env is set).
 */
export function assertCloudConfigFingerprintFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldEnforceCloudConfigFingerprint(env)) {
    return;
  }

  const result = checkCloudConfigFingerprint({
    configJsonB64: env.HARNESS_CONFIG_JSON_B64,
    expectedFingerprint: env[HARNESS_CONFIG_FINGERPRINT_VARIABLE],
    enforce: true,
  });

  if (!result.ok) {
    throw new CloudConfigStaleError(result.message);
  }
}
