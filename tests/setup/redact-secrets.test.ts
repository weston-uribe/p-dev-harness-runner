import { describe, expect, it } from "vitest";
import {
  collectRemoteSecretInputs,
  redactSecretEnvContent,
  sanitizeSetupActionResult,
} from "../../src/setup/redact-secrets.js";

describe("redact-secrets", () => {
  it("redacts secret env assignment lines with values", () => {
    const content = [
      "LINEAR_API_KEY=fake-linear-secret",
      "CURSOR_API_KEY=fake-cursor-secret",
      "GITHUB_TOKEN=fake-github-secret",
      "HARNESS_GITHUB_TOKEN=fake-harness-github-secret",
      "HARNESS_CONFIG_JSON_B64=abc123encoded",
    ].join("\n");

    const redacted = redactSecretEnvContent(content);

    expect(redacted).toContain("LINEAR_API_KEY=<redacted>");
    expect(redacted).toContain("CURSOR_API_KEY=<redacted>");
    expect(redacted).toContain("GITHUB_TOKEN=<redacted>");
    expect(redacted).toContain("HARNESS_GITHUB_TOKEN=<redacted>");
    expect(redacted).toContain("HARNESS_CONFIG_JSON_B64=<redacted>");
    expect(redacted).not.toContain("fake-linear-secret");
    expect(redacted).not.toContain("fake-cursor-secret");
    expect(redacted).not.toContain("fake-github-secret");
    expect(redacted).not.toContain("fake-harness-github-secret");
    expect(redacted).not.toContain("abc123encoded");
  });

  it("preserves empty secret key placeholders", () => {
    const content = "LINEAR_API_KEY=\nCURSOR_API_KEY=";
    expect(redactSecretEnvContent(content)).toBe(content);
  });

  it("sanitizes all SetupActionResult text fields", () => {
    const secret = "super-secret-token";
    const sanitized = sanitizeSetupActionResult(
      {
        actionId: "write-env-local",
        outcome: "preview",
        content: `GITHUB_TOKEN=${secret}`,
        reason: `would write ${secret}`,
        logMessage: `preview includes ${secret}`,
        manualInstructions: [`Set GITHUB_TOKEN to ${secret}`],
        permission: {
          scope: "local-file-write",
          confirmation: "standard",
          manualAlternative: true,
        },
      },
      [secret],
    );

    const combined = [
      sanitized.content,
      sanitized.reason,
      sanitized.logMessage,
      ...(sanitized.manualInstructions ?? []),
    ].join("\n");

    expect(combined).not.toContain(secret);
    expect(combined).toContain("GITHUB_TOKEN=<redacted>");
    expect(combined).toContain("<redacted>");
  });

  it("collects remote secret inputs for redaction", () => {
    const secret = "super-secret-token";
    const collected = collectRemoteSecretInputs({
      linearApiKey: secret,
      harnessConfigJsonB64: "encoded-config-value",
    });

    expect(collected).toContain(secret);
    expect(collected).toContain("encoded-config-value");
  });
});
