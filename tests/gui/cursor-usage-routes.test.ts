import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE as preflightDelete,
  GET as preflightGet,
  POST as preflightPost,
} from "../../apps/gui/app/api/settings/cursor-usage/preflight/route.js";
import { POST as applyPost } from "../../apps/gui/app/api/settings/cursor-usage/apply/route.js";
import { POST as inspectPost } from "../../apps/gui/app/api/settings/cursor-usage/inspect/route.js";
import { GET as configGet } from "../../apps/gui/app/api/settings/cursor-usage/config/route.js";
import { P_DEV_OBSERVABILITY_NONCE_ENV } from "../../src/observability/constants.js";
import { installDiscoveryEnv } from "../evaluation/helpers/cursor-usage-discovery-test.js";
import { resetPreflightOperationsForTests } from "../../src/evaluation/cursor-usage-import/preflight-operation-registry.js";

vi.mock("server-only", () => ({}));

vi.mock("../../src/evaluation/langfuse-inspect/client.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/evaluation/langfuse-inspect/client.js")
  >();
  return {
    ...actual,
    createLangfuseApiClient: async () => ({
      api: {
        sessions: { get: async () => null },
        trace: {
          list: async () => ({ data: [], meta: { page: 1, totalPages: 1 } }),
          get: async () => null,
        },
        observations: { getMany: async () => ({ data: [] }) },
      },
    }),
  };
});

vi.mock("../../src/evaluation/cursor-usage-import/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/evaluation/cursor-usage-import/discovery.js")
  >();
  return {
    ...actual,
    discoverUsageCandidates: async () => ({
      candidates: [],
      retrievalComplete: true,
      pagesFetched: 1,
      tracesFetched: 0,
      observationPagesFetched: 0,
      observationsFetched: 0,
      targetObservationsRetained: 0,
      requestCounters: {
        discoveryInvocationId: "route-test-discovery",
        traceListRequestCount: 1,
        observationRequestCount: 0,
        perTraceObservationRequestCount: 0,
      },
    }),
  };
});

const fixtureCsv = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cursor-usage/sample-usage.csv",
);

function buildMultipartRequest(input: {
  host?: string;
  origin?: string;
  nonce?: string;
  body: FormData;
  path?: string;
}): NextRequest {
  const host = input.host ?? "127.0.0.1:4317";
  const headers = new Headers({
    host,
    origin: input.origin ?? `http://${host}`,
  });
  if (input.nonce) {
    headers.set("x-p-dev-observability-nonce", input.nonce);
  }
  const routePath = input.path ?? "/api/settings/cursor-usage/preflight";
  return new NextRequest(`http://${host}${routePath}`, {
    method: "POST",
    headers,
    body: input.body,
  });
}

function buildApplyRequest(input: {
  host?: string;
  origin?: string;
  nonce?: string;
  body: Record<string, unknown>;
}): NextRequest {
  const host = input.host ?? "127.0.0.1:4317";
  const headers = new Headers({
    host,
    origin: input.origin ?? `http://${host}`,
    "content-type": "application/json",
  });
  if (input.nonce) {
    headers.set("x-p-dev-observability-nonce", input.nonce);
  }
  return new NextRequest(`http://${host}/api/settings/cursor-usage/apply`, {
    method: "POST",
    headers,
    body: JSON.stringify(input.body),
  });
}

function buildStatusRequest(input: {
  operationId: string;
  host?: string;
  origin?: string;
  nonce?: string;
  method?: "GET" | "DELETE";
}): NextRequest {
  const host = input.host ?? "127.0.0.1:4317";
  const headers = new Headers({
    host,
    origin: input.origin ?? `http://${host}`,
  });
  if (input.nonce) {
    headers.set("x-p-dev-observability-nonce", input.nonce);
  }
  return new NextRequest(
    `http://${host}/api/settings/cursor-usage/preflight?operationId=${encodeURIComponent(input.operationId)}`,
    {
      method: input.method ?? "GET",
      headers,
    },
  );
}

async function awaitPreflightResult(operationId: string): Promise<{
  importId: string;
  fingerprint: string;
  rows: Array<{ cloudAgentIdHash: string }>;
  publicSummary: { observedWindow?: { startIso: string; endIso: string } };
}> {
  for (let i = 0; i < 100; i += 1) {
    const response = await preflightGet(
      buildStatusRequest({
        operationId,
        nonce: "cursor-usage-test-nonce",
      }),
    );
    expect(response.status).toBe(200);
    const status = (await response.json()) as {
      state: string;
      errorMessage?: string | null;
      result?: {
        importId: string;
        fingerprint: string;
        rows: Array<{ cloudAgentIdHash: string }>;
        publicSummary: { observedWindow?: { startIso: string; endIso: string } };
      } | null;
    };
    if (status.state === "succeeded" && status.result) {
      return status.result;
    }
    if (status.state === "failed" || status.state === "cancelled") {
      throw new Error(status.errorMessage ?? `preflight ${status.state}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("preflight timed out waiting for terminal status");
}

describe("cursor usage routes", () => {
  let workspaceDir = "";
  const originalRepoRoot = process.env.HARNESS_REPO_ROOT;
  const originalGuiPort = process.env.HARNESS_GUI_PORT;
  const originalGuiHost = process.env.HARNESS_GUI_HOST;
  const originalNonceEnv = process.env[P_DEV_OBSERVABILITY_NONCE_ENV];

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "cursor-usage-routes-"));
    process.env.HARNESS_REPO_ROOT = workspaceDir;
    process.env.HARNESS_GUI_PORT = "4317";
    process.env.HARNESS_GUI_HOST = "127.0.0.1";
    process.env[P_DEV_OBSERVABILITY_NONCE_ENV] = "cursor-usage-test-nonce";
    installDiscoveryEnv(process.env);
    process.env.P_DEV_EVALUATION_NAMESPACE = "weston-dogfood";
    process.env.LANGFUSE_TRACING_ENVIRONMENT = "dogfood";
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".harness/config.local.json"),
      JSON.stringify({ version: 1, logDirectory: "runs", repos: [] }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "P_DEV_EVALUATION_PROVIDER=langfuse",
        "P_DEV_EVALUATION_NAMESPACE=weston-dogfood",
        "LANGFUSE_TRACING_ENVIRONMENT=dogfood",
        "LANGFUSE_PUBLIC_KEY=pk-test-cursor-usage",
        "LANGFUSE_SECRET_KEY=sk-test-cursor-usage",
        "LANGFUSE_BASE_URL=http://127.0.0.1:18999",
      ].join("\n") + "\n",
      "utf8",
    );
  });

  afterEach(async () => {
    resetPreflightOperationsForTests();
    if (originalRepoRoot === undefined) {
      delete process.env.HARNESS_REPO_ROOT;
    } else {
      process.env.HARNESS_REPO_ROOT = originalRepoRoot;
    }
    if (originalGuiPort === undefined) {
      delete process.env.HARNESS_GUI_PORT;
    } else {
      process.env.HARNESS_GUI_PORT = originalGuiPort;
    }
    if (originalGuiHost === undefined) {
      delete process.env.HARNESS_GUI_HOST;
    } else {
      process.env.HARNESS_GUI_HOST = originalGuiHost;
    }
    if (originalNonceEnv === undefined) {
      delete process.env[P_DEV_OBSERVABILITY_NONCE_ENV];
    } else {
      process.env[P_DEV_OBSERVABILITY_NONCE_ENV] = originalNonceEnv;
    }
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("rejects cross-origin preflight requests", async () => {
    const formData = new FormData();
    formData.set("file", new File(["x"], "usage.csv", { type: "text/csv" }));
    formData.set("exportStart", "2026-07-19T00:00:00.000Z");
    formData.set("exportEnd", "2026-07-19T23:59:59.000Z");

    const response = await preflightPost(
      buildMultipartRequest({
        origin: "http://evil.example:4317",
        nonce: "cursor-usage-test-nonce",
        body: formData,
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden origin." });
  });

  it("rejects cross-origin apply requests", async () => {
    const response = await applyPost(
      buildApplyRequest({
        origin: "http://evil.example:4317",
        nonce: "cursor-usage-test-nonce",
        body: {
          importId: "00000000-0000-0000-0000-000000000001",
          fingerprint: "abc",
          confirmed: true,
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden origin." });
  });

  it("serves config without secrets", async () => {
    const response = await configGet(
      new NextRequest("http://127.0.0.1:4317/api/settings/cursor-usage/config", {
        method: "GET",
        headers: {
          host: "127.0.0.1:4317",
        },
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.langfuseConfigured).toBe(true);
    expect(payload.configurationStatus).toBe("ready");
    expect(payload.namespace).toBe("weston-dogfood");
    expect(payload.environment).toBe("dogfood");
    expect(payload.langfuseHost).toBe("127.0.0.1");
    expect(payload).toHaveProperty("adminKeyConfigured");
    expect(JSON.stringify(payload)).not.toMatch(/\bsk-/);
    expect(JSON.stringify(payload)).not.toMatch(/\bpk-/);
    expect(JSON.stringify(payload)).not.toContain("langfuseProjectScopeDigest");
  });

  it("blocks preflight when provider is missing", async () => {
    delete process.env.P_DEV_EVALUATION_PROVIDER;
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "P_DEV_EVALUATION_NAMESPACE=weston-dogfood",
        "LANGFUSE_PUBLIC_KEY=pk-test-cursor-usage",
        "LANGFUSE_SECRET_KEY=sk-test-cursor-usage",
        "LANGFUSE_BASE_URL=http://127.0.0.1:18999",
      ].join("\n") + "\n",
      "utf8",
    );
    const csv = await readFile(fixtureCsv, "utf8");
    const formData = new FormData();
    formData.set("file", new File([csv], "sample-usage.csv", { type: "text/csv" }));
    formData.set("boundsSource", "csv_row_extrema");
    const response = await preflightPost(
      buildMultipartRequest({
        nonce: "cursor-usage-test-nonce",
        body: formData,
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; code: string };
    expect(payload.code).toBe("langfuse_not_configured");
  });

  it("runs preflight without exposing private agent ids", async () => {
    const csv = await readFile(fixtureCsv, "utf8");
    const formData = new FormData();
    formData.set("file", new File([csv], "sample-usage.csv", { type: "text/csv" }));
    formData.set("boundsSource", "csv_row_extrema");
    formData.set("advancedOverride", "false");

    const response = await preflightPost(
      buildMultipartRequest({
        nonce: "cursor-usage-test-nonce",
        body: formData,
      }),
    );

    expect(response.status).toBe(202);
    const started = (await response.json()) as { operationId: string };
    expect(started.operationId).toBeTruthy();
    const payload = await awaitPreflightResult(started.operationId);
    expect(payload.importId).toBeTruthy();
    expect(payload.fingerprint).toBeTruthy();
    expect(payload.publicSummary.observedWindow?.startIso).toBe(
      "2026-07-19T12:00:00.000Z",
    );
    expect(payload.publicSummary.observedWindow?.endIso).toBe(
      "2026-07-19T13:00:00.000Z",
    );
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("bc-agent-planning-001");
    expect(serialized).not.toContain("bc-agent-planreview-001");
    for (const row of payload.rows) {
      expect(row.cloudAgentIdHash.length).toBeLessThanOrEqual(12);
    }
  });

  it("requires operator auth to poll or cancel preflight status", async () => {
    const csv = await readFile(fixtureCsv, "utf8");
    const formData = new FormData();
    formData.set("file", new File([csv], "sample-usage.csv", { type: "text/csv" }));
    formData.set("boundsSource", "csv_row_extrema");
    const started = await preflightPost(
      buildMultipartRequest({
        nonce: "cursor-usage-test-nonce",
        body: formData,
      }),
    );
    expect(started.status).toBe(202);
    const { operationId } = (await started.json()) as { operationId: string };
    await awaitPreflightResult(operationId);

    const noNonce = await preflightGet(buildStatusRequest({ operationId }));
    expect(noNonce.status).toBe(403);

    const badOrigin = await preflightGet(
      buildStatusRequest({
        operationId,
        origin: "http://evil.example:4317",
        nonce: "cursor-usage-test-nonce",
      }),
    );
    expect(badOrigin.status).toBe(403);

    const missing = await preflightGet(
      buildStatusRequest({
        operationId: "does-not-exist",
        nonce: "cursor-usage-test-nonce",
      }),
    );
    expect(missing.status).toBe(404);

    const cancelMissing = await preflightDelete(
      buildStatusRequest({
        operationId: "does-not-exist",
        nonce: "cursor-usage-test-nonce",
        method: "DELETE",
      }),
    );
    expect(cancelMissing.status).toBe(404);
  });

  it("inspect rejects unauthorized, wrong-origin, oversized, and malformed input", async () => {
    const csv = await readFile(fixtureCsv, "utf8");
    const formData = new FormData();
    formData.set("file", new File([csv], "sample-usage.csv", { type: "text/csv" }));

    const noNonce = await inspectPost(
      buildMultipartRequest({
        path: "/api/settings/cursor-usage/inspect",
        body: formData,
      }),
    );
    expect(noNonce.status).toBe(403);

    const badOrigin = await inspectPost(
      buildMultipartRequest({
        path: "/api/settings/cursor-usage/inspect",
        origin: "http://evil.example:4317",
        nonce: "cursor-usage-test-nonce",
        body: formData,
      }),
    );
    expect(badOrigin.status).toBe(403);

    const noFile = new FormData();
    const missing = await inspectPost(
      buildMultipartRequest({
        path: "/api/settings/cursor-usage/inspect",
        nonce: "cursor-usage-test-nonce",
        body: noFile,
      }),
    );
    expect(missing.status).toBe(400);

    const badName = new FormData();
    badName.set("file", new File(["x"], "usage.txt", { type: "text/plain" }));
    const badExt = await inspectPost(
      buildMultipartRequest({
        path: "/api/settings/cursor-usage/inspect",
        nonce: "cursor-usage-test-nonce",
        body: badName,
      }),
    );
    expect(badExt.status).toBe(400);
  });

  it("inspect returns secret-safe source summary and binds digest for preflight", async () => {
    const csv = await readFile(fixtureCsv, "utf8");
    const inspectForm = new FormData();
    inspectForm.set(
      "file",
      new File([csv], "sample-usage.csv", { type: "text/csv" }),
    );
    const inspected = await inspectPost(
      buildMultipartRequest({
        path: "/api/settings/cursor-usage/inspect",
        nonce: "cursor-usage-test-nonce",
        body: inspectForm,
      }),
    );
    expect(inspected.status).toBe(200);
    const inspection = (await inspected.json()) as {
      sourceDigestSha256: string;
      inspectionToken: string;
      minTimestampIso: string;
      maxTimestampIso: string;
      timezoneEvidence: string;
      cloudAgentAttributableRowCount: number;
    };
    expect(inspection.timezoneEvidence).toBe("UTC");
    expect(inspection.minTimestampIso < inspection.maxTimestampIso).toBe(true);
    expect(inspection.cloudAgentAttributableRowCount).toBe(3);
    expect(JSON.stringify(inspection)).not.toContain("bc-agent-planning-001");

    const stale = new FormData();
    stale.set("file", new File([csv], "sample-usage.csv", { type: "text/csv" }));
    stale.set("boundsSource", "csv_row_extrema");
    stale.set("expectedSourceDigestSha256", "0".repeat(64));
    stale.set("expectedInspectionToken", inspection.inspectionToken);
    const staleResp = await preflightPost(
      buildMultipartRequest({
        nonce: "cursor-usage-test-nonce",
        body: stale,
      }),
    );
    expect(staleResp.status).toBe(400);

    const ok = new FormData();
    ok.set("file", new File([csv], "sample-usage.csv", { type: "text/csv" }));
    ok.set("boundsSource", "csv_row_extrema");
    ok.set("expectedSourceDigestSha256", inspection.sourceDigestSha256);
    ok.set("expectedInspectionToken", inspection.inspectionToken);
    const okResp = await preflightPost(
      buildMultipartRequest({
        nonce: "cursor-usage-test-nonce",
        body: ok,
      }),
    );
    expect(okResp.status).toBe(202);
    const { operationId } = (await okResp.json()) as { operationId: string };
    const result = await awaitPreflightResult(operationId);
    expect(result.importId).toBeTruthy();
  });
});
