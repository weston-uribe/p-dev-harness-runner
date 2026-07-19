import { describe, expect, it } from "vitest";
import {
  checkCloudConfigFingerprint,
  fingerprintHarnessConfigBytes,
  fingerprintHarnessConfigJsonB64,
  shouldEnforceCloudConfigFingerprint,
} from "../../src/config/cloud-config-fingerprint.js";

describe("cloud-config-fingerprint", () => {
  it("fingerprints config bytes and matching base64 identically", () => {
    const bytes = Buffer.from(JSON.stringify({ version: 1, repos: [] }), "utf8");
    const b64 = bytes.toString("base64");
    expect(fingerprintHarnessConfigJsonB64(b64)).toBe(
      fingerprintHarnessConfigBytes(bytes),
    );
  });

  it("passes when secret and variable fingerprints match", () => {
    const bytes = Buffer.from('{"ok":true}', "utf8");
    const fingerprint = fingerprintHarnessConfigBytes(bytes);
    const result = checkCloudConfigFingerprint({
      configJsonB64: bytes.toString("base64"),
      expectedFingerprint: fingerprint,
      enforce: true,
    });
    expect(result.ok).toBe(true);
  });

  it("returns cloud_config_stale on mismatch", () => {
    const bytes = Buffer.from('{"ok":true}', "utf8");
    const result = checkCloudConfigFingerprint({
      configJsonB64: bytes.toString("base64"),
      expectedFingerprint: "deadbeef",
      enforce: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClassification).toBe("cloud_config_stale");
    }
  });

  it("enforces only in GitHub Actions with config secret present", () => {
    expect(
      shouldEnforceCloudConfigFingerprint({
        GITHUB_ACTIONS: "true",
        HARNESS_CONFIG_JSON_B64: "abc",
      }),
    ).toBe(true);
    expect(
      shouldEnforceCloudConfigFingerprint({
        GITHUB_ACTIONS: "true",
      }),
    ).toBe(false);
    expect(
      shouldEnforceCloudConfigFingerprint({
        GITHUB_ACTIONS: "true",
        HARNESS_CONFIG_JSON_B64: "abc",
        HARNESS_SKIP_CLOUD_CONFIG_FINGERPRINT: "1",
      }),
    ).toBe(false);
  });
});
