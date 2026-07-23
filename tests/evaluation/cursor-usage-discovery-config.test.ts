import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeLangfuseEndpoint,
  computeLangfuseProjectScopeDigest,
  CursorUsageDiscoveryError,
  resolveCursorUsageDiscoveryConfig,
} from "../../src/evaluation/cursor-usage-import/discovery-config.js";
import { preflightCsvImport } from "../../src/evaluation/cursor-usage-import/service.js";
import { stagingDir } from "../../src/evaluation/cursor-usage-import/staging.js";
import {
  makeReadyDiscoveryConfig,
  readyDiscoveryResolver,
} from "./helpers/cursor-usage-discovery-test.js";
import type { LangfuseApiClient } from "../../src/evaluation/langfuse-inspect/client.js";

const CSV_HEADER =
  "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";
const VALID_ROW =
  "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,0,10,0,5,15,Included";

const exportWindow = {
  startIso: "2026-07-19T00:00:00.000Z",
  endIso: "2026-07-20T00:00:00.000Z",
  timezone: "UTC",
  precision: "millisecond" as const,
  boundsSource: "cli_flags" as const,
};

function assertNoStaging(logDirectory: string): void {
  const root = path.join(logDirectory, "evaluation-reports", "cursor-usage-imports");
  if (!existsSync(root)) return;
  expect(readdirSync(root)).toEqual([]);
}

describe("cursor usage discovery config", () => {
  it("requires explicit provider", () => {
    const resolved = resolveCursorUsageDiscoveryConfig({
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      P_DEV_EVALUATION_NAMESPACE: "weston-dogfood",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.publicConfig.configurationStatus).toBe("provider_missing");
    expect(resolved.publicConfig.errorCode).toBe("langfuse_not_configured");
    expect(resolved.publicConfig.namespace).toBe("weston-dogfood");
  });

  it("requires explicit namespace and never falls back to default", () => {
    const resolved = resolveCursorUsageDiscoveryConfig({
      P_DEV_EVALUATION_PROVIDER: "langfuse",
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.publicConfig.configurationStatus).toBe("namespace_missing");
    expect(resolved.publicConfig.namespace).toBeNull();
    expect(resolved.publicConfig.errorCode).toBe("langfuse_namespace_missing");
  });

  it("treats unset environment as no filter", () => {
    const resolved = resolveCursorUsageDiscoveryConfig({
      P_DEV_EVALUATION_PROVIDER: "langfuse",
      P_DEV_EVALUATION_NAMESPACE: "weston-dogfood",
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.environmentFilter).toBeNull();
    expect(resolved.publicConfig.environmentFilterExplicit).toBe(false);
    expect(resolved.publicConfig.langfuseHost).toBe("us.cloud.langfuse.com");
  });

  it("uses explicit dogfood environment filter", () => {
    const resolved = resolveCursorUsageDiscoveryConfig({
      P_DEV_EVALUATION_PROVIDER: "langfuse",
      P_DEV_EVALUATION_NAMESPACE: "weston-dogfood",
      LANGFUSE_TRACING_ENVIRONMENT: "dogfood",
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.environmentFilter).toBe("dogfood");
    expect(resolved.publicConfig.environmentFilterExplicit).toBe(true);
  });

  it("canonicalizes endpoint identity and rejects embedded credentials", () => {
    const ok = canonicalizeLangfuseEndpoint("https://US.Cloud.Langfuse.com/");
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.identity.hostname).toBe("us.cloud.langfuse.com");
    expect(ok.identity.scheme).toBe("https");
    expect(ok.identity.port).toBe(443);
    expect(ok.identity.canonicalUrl).toBe("https://us.cloud.langfuse.com");

    const bad = canonicalizeLangfuseEndpoint(
      "https://user:pass@us.cloud.langfuse.com",
    );
    expect(bad.ok).toBe(false);

    const httpRemote = canonicalizeLangfuseEndpoint("http://example.com");
    expect(httpRemote.ok).toBe(false);

    const httpLoopback = canonicalizeLangfuseEndpoint("http://127.0.0.1:18999");
    expect(httpLoopback.ok).toBe(true);
  });

  it("fingerprints project scope from endpoint + public key digest", () => {
    const a = makeReadyDiscoveryConfig({ publicKey: "pk-a" });
    const b = makeReadyDiscoveryConfig({ publicKey: "pk-b" });
    const aSecretRotated = makeReadyDiscoveryConfig({
      publicKey: "pk-a",
      secretKey: "sk-rotated",
    });
    expect(a.langfuseProjectScopeDigest).not.toBe(b.langfuseProjectScopeDigest);
    expect(a.langfuseProjectScopeDigest).toBe(
      aSecretRotated.langfuseProjectScopeDigest,
    );
    expect(a.langfuseProjectScopeDigest).toBe(
      computeLangfuseProjectScopeDigest({
        canonicalEndpointIdentity: a.canonicalEndpointIdentity,
        publicKey: "pk-a",
      }),
    );
  });

  it("blocks staging when provider is missing", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cu-disc-"));
    let scoreClientCalls = 0;
    await expect(
      preflightCsvImport({
        csvBytes: `${CSV_HEADER}\n${VALID_ROW}\n`,
        exportWindow,
        namespace: "ignored",
        logDirectory,
        discoverLangfuse: true,
        deps: {
          resolveDiscoveryConfig: () =>
            resolveCursorUsageDiscoveryConfig({
              LANGFUSE_PUBLIC_KEY: "pk",
              LANGFUSE_SECRET_KEY: "sk",
              P_DEV_EVALUATION_NAMESPACE: "ns",
            }),
          createScoreClient: async () => {
            scoreClientCalls += 1;
            return { recordScore() {}, flush: async () => {} };
          },
        },
      }),
    ).rejects.toBeInstanceOf(CursorUsageDiscoveryError);
    assertNoStaging(logDirectory);
    expect(scoreClientCalls).toBe(0);
  });

  it("passes environment undefined when filter is null", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cu-disc-"));
    const config = makeReadyDiscoveryConfig({
      namespace: "weston-dogfood",
      environmentFilter: null,
    });
    let seenEnvironment: string | undefined = "sentinel";
    await preflightCsvImport({
      csvBytes: `${CSV_HEADER}\n${VALID_ROW}\n`,
      exportWindow,
      namespace: "ignored",
      logDirectory,
      discoverLangfuse: true,
      deps: {
        resolveDiscoveryConfig: readyDiscoveryResolver(config),
        createApiClient: async () => ({}) as LangfuseApiClient,
        discover: async (params) => {
          seenEnvironment = params.environment;
          return {
            candidates: [],
            retrievalComplete: true,
            pagesFetched: 1,
            tracesFetched: 0,
          };
        },
      },
    });
    expect(seenEnvironment).toBeUndefined();
    expect(
      existsSync(stagingDir(logDirectory, "x")) ||
        existsSync(path.join(logDirectory, "evaluation-reports")),
    ).toBe(true);
  });

  it("passes dogfood environment when explicit", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cu-disc-"));
    const config = makeReadyDiscoveryConfig({
      namespace: "weston-dogfood",
      environmentFilter: "dogfood",
    });
    let seenEnvironment: string | undefined;
    await preflightCsvImport({
      csvBytes: `${CSV_HEADER}\n${VALID_ROW}\n`,
      exportWindow,
      namespace: "ignored",
      logDirectory,
      discoverLangfuse: true,
      deps: {
        resolveDiscoveryConfig: readyDiscoveryResolver(config),
        createApiClient: async () => ({}) as LangfuseApiClient,
        discover: async (params) => {
          seenEnvironment = params.environment;
          return {
            candidates: [],
            retrievalComplete: true,
            pagesFetched: 1,
            tracesFetched: 0,
          };
        },
      },
    });
    expect(seenEnvironment).toBe("dogfood");
  });

  it("stages diagnostic preflight for zero traces", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cu-disc-"));
    const result = await preflightCsvImport({
      csvBytes: `${CSV_HEADER}\n${VALID_ROW}\n`,
      exportWindow,
      namespace: "ignored",
      logDirectory,
      discoverLangfuse: true,
      deps: {
        resolveDiscoveryConfig: readyDiscoveryResolver(
          makeReadyDiscoveryConfig({ namespace: "weston-dogfood" }),
        ),
        createApiClient: async () => ({}) as LangfuseApiClient,
        discover: async () => ({
          candidates: [],
          retrievalComplete: true,
          pagesFetched: 1,
          tracesFetched: 0,
        }),
      },
    });
    expect(result.sourceScopeComplete).toBe(false);
    expect(result.publicSummary.sourceScopeIncompleteReason).toBe(
      "langfuse_no_traces_in_window",
    );
    expect(result.discoveryDiagnostics?.status).toBe("no_traces_in_window");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(existsSync(stagingDir(logDirectory, result.importId))).toBe(true);
  });
});
