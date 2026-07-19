import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsString } from "../../src/artifacts/redact.js";

describe("redactSecretsString", () => {
  it("redacts Linear API keys", () => {
    const input = "auth failed: lin_api_abc123xyz";
    expect(redactSecretsString(input)).toBe("auth failed: [REDACTED]");
  });

  it("redacts GitHub PATs", () => {
    const input = "token ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    expect(redactSecretsString(input)).toContain("[REDACTED]");
    expect(redactSecretsString(input)).not.toContain("ghp_");
  });

  it.each([
    "gho_abcdefghijklmnopqrst",
    "ghu_abcdefghijklmnopqrst",
    "ghs_abcdefghijklmnopqrst",
    "ghr_abcdefghijklmnopqrst",
  ])("redacts GitHub token prefix %s", (token) => {
    const input = `auth failed: ${token}`;
    expect(redactSecretsString(input)).toBe("auth failed: [REDACTED]");
    expect(redactSecretsString(input)).not.toContain(token.slice(0, 4));
  });

  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOi.test";
    expect(redactSecretsString(input)).toContain("[REDACTED]");
  });

  it("truncates long error bodies", () => {
    const input = `error: ${"x".repeat(300)}`;
    expect(redactSecretsString(input).length).toBeLessThanOrEqual(201);
  });
});

describe("redactSecrets", () => {
  it("redacts sensitive object keys", () => {
    const result = redactSecrets({
      apiKey: "lin_api_secret",
      nested: { token: "ghp_test" },
      safe: "visible",
    }) as Record<string, unknown>;

    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.nested).toEqual({ token: "[REDACTED]" });
    expect(result.safe).toBe("visible");
  });

  it("redacts token patterns in string values", () => {
    const result = redactSecrets({
      message: "failed with ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    }) as Record<string, unknown>;

    expect(result.message).toContain("[REDACTED]");
  });
});
