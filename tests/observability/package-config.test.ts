import { describe, expect, it } from "vitest";
import {
  parseObservabilityPublicConfigJson,
  readObservabilityPublicConfig,
  resolveObservabilityPublicConfigForPrepare,
} from "../../src/observability/package-config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("observability foundation package config", () => {
  it("uses packaged env overrides when moduleUrl cannot resolve public config files", () => {
    const config = readObservabilityPublicConfig(
      "file:///tmp/gui/.next/server/chunks/preferences-route.js",
      {
        P_DEV_RUNTIME_MODE: "packaged",
        P_DEV_SENTRY_DSN: "http://public@127.0.0.1:9/1",
        P_DEV_POSTHOG_PROJECT_TOKEN: "phc_test",
        P_DEV_POSTHOG_HOST: "http://127.0.0.1:9",
      },
    );

    expect(config).toEqual({
      observabilitySchemaVersion: 1,
      sentryPublicDsn: "http://public@127.0.0.1:9/1",
      posthogProjectToken: "phc_test",
      posthogIngestionHost: "http://127.0.0.1:9",
      sourcePath: "env",
    });
  });

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

  it("reads tracked public Sentry DSN without env override", () => {
    const tracked = resolveObservabilityPublicConfigForPrepare(repoRoot);
    const config = readObservabilityPublicConfig(
      path.join(repoRoot, "src/observability/package-config.ts"),
      {
        P_DEV_RUNTIME_MODE: "packaged",
      },
    );
    expect(config?.sentryPublicDsn).toBe(tracked.sentryPublicDsn);
    expect(config?.posthogProjectToken).not.toBe("");
    expect(config?.posthogProjectToken.startsWith("phc_")).toBe(true);
    expect(config?.sentryPublicDsn).not.toBe("");
    const url = new URL(config!.sentryPublicDsn);
    expect(url.hostname).toMatch(/\.ingest\.us\.sentry\.io$/);
    expect(url.pathname).toBe("/4511740568338432");
  });
});
