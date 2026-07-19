import { createHash } from "node:crypto";

/** Non-secret GitHub Actions repository variable paired with HARNESS_CONFIG_JSON_B64. */
export const HARNESS_CONFIG_FINGERPRINT_VARIABLE = "HARNESS_CONFIG_FINGERPRINT";

export function fingerprintHarnessConfigBytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fingerprintHarnessConfigJsonB64(b64: string): string {
  const bytes = Buffer.from(b64.trim(), "base64");
  return fingerprintHarnessConfigBytes(bytes);
}

export type CloudConfigFingerprintCheckResult =
  | { ok: true; fingerprint: string }
  | {
      ok: false;
      errorClassification: "cloud_config_stale";
      message: string;
      decodedFingerprint: string | null;
      expectedFingerprint: string | null;
    };

/**
 * Compare decoded HARNESS_CONFIG_JSON_B64 fingerprint against the paired
 * repository variable. Fail closed when either side is missing or they differ.
 */
export function checkCloudConfigFingerprint(input: {
  configJsonB64?: string | null;
  expectedFingerprint?: string | null;
  /** When false (local/dev), skip the check. */
  enforce?: boolean;
}): CloudConfigFingerprintCheckResult {
  if (input.enforce === false) {
    return { ok: true, fingerprint: input.expectedFingerprint?.trim() || "" };
  }

  const b64 = input.configJsonB64?.trim() || "";
  const expected = input.expectedFingerprint?.trim() || "";

  if (!b64 && !expected) {
    return { ok: true, fingerprint: "" };
  }

  if (!b64 || !expected) {
    return {
      ok: false,
      errorClassification: "cloud_config_stale",
      message:
        "cloud_config_stale: HARNESS_CONFIG_JSON_B64 and HARNESS_CONFIG_FINGERPRINT must both be present",
      decodedFingerprint: b64 ? fingerprintHarnessConfigJsonB64(b64) : null,
      expectedFingerprint: expected || null,
    };
  }

  let decodedFingerprint: string;
  try {
    decodedFingerprint = fingerprintHarnessConfigJsonB64(b64);
  } catch {
    return {
      ok: false,
      errorClassification: "cloud_config_stale",
      message: "cloud_config_stale: HARNESS_CONFIG_JSON_B64 could not be decoded",
      decodedFingerprint: null,
      expectedFingerprint: expected,
    };
  }

  if (decodedFingerprint !== expected) {
    return {
      ok: false,
      errorClassification: "cloud_config_stale",
      message:
        "cloud_config_stale: decoded harness config fingerprint does not match HARNESS_CONFIG_FINGERPRINT",
      decodedFingerprint,
      expectedFingerprint: expected,
    };
  }

  return { ok: true, fingerprint: decodedFingerprint };
}

export function shouldEnforceCloudConfigFingerprint(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HARNESS_SKIP_CLOUD_CONFIG_FINGERPRINT === "1") {
    return false;
  }
  // Enforce in GitHub Actions when the secret is loaded from env.
  return Boolean(env.GITHUB_ACTIONS === "true" && env.HARNESS_CONFIG_JSON_B64?.trim());
}
