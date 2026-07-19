import { describe, expect, it } from "vitest";
import {
  parseObservabilityPublicConfigJson,
  resolveObservabilityPublicConfigForPrepare,
} from "../../src/observability/package-config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readTrackedPublicConfig() {
  return resolveObservabilityPublicConfigForPrepare(repoRoot);
}

describe("observability public config enablement", () => {
  it("packages a public PostHog project token from tracked config", () => {
    const tracked = readTrackedPublicConfig();
    expect(tracked.posthogProjectToken).not.toBe("");
    expect(tracked.posthogProjectToken.startsWith("phc_")).toBe(true);
    expect(tracked.posthogProjectToken.startsWith("phx_")).toBe(false);
    expect(tracked.posthogIngestionHost).toBe("https://us.i.posthog.com");
  });

  it("preserves the Sentry public DSN identity in tracked config", () => {
    const tracked = readTrackedPublicConfig();
    const url = new URL(tracked.sentryPublicDsn);
    expect(url.hostname).toMatch(/\.ingest\.us\.sentry\.io$/);
    expect(url.pathname).toBe("/4511740568338432");
    expect(url.username).toMatch(/^[0-9a-f]{32}$/i);
  });

  it("rejects personal API keys in public config parsing", () => {
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
});
