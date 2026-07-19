import { describe, expect, it } from "vitest";
import { parseObservabilityPublicConfigJson } from "../../src/observability/package-config.js";
import {
  ALLOWED_SENTRY_TAG_KEYS,
  assertAllowedPropertyKeys,
  allowedAnalyticsPropertyKeysForEvent,
  analyticsEventToProperties,
} from "../../src/observability/privacy-schema.js";
import { sanitizeObservabilityString } from "../../src/observability/redaction.js";

const PRIVACY_FIXTURE = [
  "ghp_1234567890abcdef",
  "lin_api_deadbeef",
  "weston@example.com",
  "/Users/weston/Code/secret-repo",
  "https://github.com/weston/private-repo?token=abc",
  "operation-id-123",
  "snapshot-content-id-456",
].join(" ");

describe("observability privacy schema", () => {
  it("rejects privileged keys in public config", () => {
    expect(() =>
      parseObservabilityPublicConfigJson(
        JSON.stringify({
          observabilitySchemaVersion: 1,
          sentryPublicDsn: "",
          posthogProjectToken: "phx_secret",
          posthogIngestionHost: "https://us.i.posthog.com",
        }),
        "test",
      ),
    ).toThrow(/personal API key/i);
  });

  it("sanitizes forbidden fixture values", () => {
    const sanitized = sanitizeObservabilityString(PRIVACY_FIXTURE);
    expect(sanitized).not.toContain("ghp_1234567890abcdef");
    expect(sanitized).not.toContain("lin_api_deadbeef");
    expect(sanitized).not.toContain("weston@example.com");
    expect(sanitized).not.toContain("/Users/weston");
    expect(sanitized).not.toContain("token=abc");
  });

  it("documents the allowlisted sentry tag contract", () => {
    expect(ALLOWED_SENTRY_TAG_KEYS).toContain("package_version");
    expect(ALLOWED_SENTRY_TAG_KEYS).toContain("release_sha");
    expect(ALLOWED_SENTRY_TAG_KEYS).not.toContain("installationId");
  });

  it("enforces analytics property allowlists", () => {
    const event = {
      type: "p_dev_configure_step_viewed" as const,
      stepId: "connect-services",
      stepNumber: 1,
      resumed: false,
      revisited: false,
    };
    const props = analyticsEventToProperties(event);
    expect(() =>
      assertAllowedPropertyKeys(
        { ...props, repo_slug: "secret" },
        allowedAnalyticsPropertyKeysForEvent(event),
      ),
    ).toThrow(/not allowlisted|forbidden/i);
  });
});

describe("observability public config contract", () => {
  it("accepts empty public ingestion values", () => {
    const parsed = parseObservabilityPublicConfigJson(
      JSON.stringify({
        observabilitySchemaVersion: 1,
        sentryPublicDsn: "",
        posthogProjectToken: "",
        posthogIngestionHost: "https://us.i.posthog.com",
      }),
      "test",
    );
    expect(parsed.sentryPublicDsn).toBe("");
    expect(parsed.posthogProjectToken).toBe("");
  });
});
