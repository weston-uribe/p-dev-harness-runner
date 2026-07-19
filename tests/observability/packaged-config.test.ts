import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveObservabilityPublicConfigForPrepare } from "../../src/observability/package-config.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function parseSentryPublicDsnIdentity(dsn: string): {
  hostname: string;
  projectId: string;
  publicKey: string;
} {
  const url = new URL(dsn);
  return {
    hostname: url.hostname,
    projectId: url.pathname.replace(/^\//, ""),
    publicKey: url.username,
  };
}

describe("observability packaged config", () => {
  it("matches tracked source config bytes", () => {
    const tracked = resolveObservabilityPublicConfigForPrepare(repoRoot);
    const packaged = JSON.parse(
      readFileSync(
        path.join(repoRoot, "packages/p-dev/observability.public.json"),
        "utf8",
      ),
    );
    expect(packaged).toEqual(tracked);
    expect(JSON.stringify(packaged)).not.toMatch(/phx_/i);
    expect(JSON.stringify(packaged)).not.toMatch(/authToken/i);
    expect(tracked.sentryPublicDsn).not.toBe("");
    expect(tracked.posthogProjectToken).not.toBe("");
    expect(tracked.posthogProjectToken.startsWith("phc_")).toBe(true);
    expect(tracked.posthogIngestionHost).toBe("https://us.i.posthog.com");

    const identity = parseSentryPublicDsnIdentity(tracked.sentryPublicDsn);
    expect(identity.hostname).toMatch(/\.ingest\.us\.sentry\.io$/);
    expect(identity.projectId).toBe("4511740568338432");
    expect(identity.publicKey).toMatch(/^[0-9a-f]{32}$/i);
  });
});
