import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST, GET } from "../../apps/gui/app/api/observability/preferences/route.js";
import {
  P_DEV_OBSERVABILITY_NONCE_ENV,
} from "../../src/observability/constants.js";
import {
  getActiveObservabilitySession,
  beginObservabilitySession,
  createObservabilityTestRecorder,
  shutdownObservability,
  writeObservabilityPreferences,
} from "../../src/observability/facade.js";
import { ALLOWED_SENTRY_TAG_KEYS } from "../../src/observability/privacy-schema.js";
import {
  createObservabilityHandoff,
  observabilityHandoffEnv,
} from "../../src/observability/session-handoff.js";

vi.mock("server-only", () => ({}));

const packagedEnv = {
  P_DEV_RUNTIME_MODE: "packaged",
  P_DEV_PACKAGE_VERSION: "0.4.0",
};

function buildPreferencesRequest(
  input: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    nonce?: string;
    host?: string;
  } = {},
): NextRequest {
  const host = input.host ?? "127.0.0.1:4317";
  const method = input.method ?? "POST";
  const headers = new Headers({
    host,
    origin: `http://${host}`,
    "content-type": "application/json",
  });
  if (method !== "GET" && input.nonce) {
    headers.set("x-p-dev-observability-nonce", input.nonce);
  }
  return new NextRequest(`http://${host}/api/observability/preferences`, {
    method,
    headers,
    body:
      method === "GET" || input.body === undefined
        ? undefined
        : JSON.stringify(input.body),
  });
}

describe("observability preferences route", () => {
  let workspaceDir = "";
  const originalRepoRoot = process.env.HARNESS_REPO_ROOT;
  const originalRuntimeMode = process.env.P_DEV_RUNTIME_MODE;
  const originalPackageVersion = process.env.P_DEV_PACKAGE_VERSION;
  const originalGuiPort = process.env.HARNESS_GUI_PORT;
  const originalGuiHost = process.env.HARNESS_GUI_HOST;
  const originalNonceEnv = process.env[P_DEV_OBSERVABILITY_NONCE_ENV];

  beforeEach(async () => {
    workspaceDir = await mkdtemp(
      path.join(tmpdir(), "observability-preferences-route-"),
    );
    process.env.HARNESS_REPO_ROOT = workspaceDir;
    process.env.P_DEV_RUNTIME_MODE = packagedEnv.P_DEV_RUNTIME_MODE;
    process.env.P_DEV_PACKAGE_VERSION = packagedEnv.P_DEV_PACKAGE_VERSION;
    process.env.HARNESS_GUI_PORT = "4317";
    process.env.HARNESS_GUI_HOST = "127.0.0.1";
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
  });

  afterEach(async () => {
    await shutdownObservability();
    if (originalRepoRoot === undefined) {
      delete process.env.HARNESS_REPO_ROOT;
    } else {
      process.env.HARNESS_REPO_ROOT = originalRepoRoot;
    }
    if (originalRuntimeMode === undefined) {
      delete process.env.P_DEV_RUNTIME_MODE;
    } else {
      process.env.P_DEV_RUNTIME_MODE = originalRuntimeMode;
    }
    if (originalPackageVersion === undefined) {
      delete process.env.P_DEV_PACKAGE_VERSION;
    } else {
      process.env.P_DEV_PACKAGE_VERSION = originalPackageVersion;
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

  async function blockHarnessPersistence(): Promise<void> {
    await rm(path.join(workspaceDir, ".harness"), { recursive: true, force: true });
    await writeFile(path.join(workspaceDir, ".harness"), "blocked", "utf8");
  }

  async function startSessionWithConsent(options?: {
    errorReportingEnabled?: boolean;
    analyticsEnabled?: boolean;
  }) {
    const recorder = createObservabilityTestRecorder();
    const errorReportingEnabled = options?.errorReportingEnabled ?? true;
    const analyticsEnabled = options?.analyticsEnabled ?? false;
    await writeObservabilityPreferences(workspaceDir, {
      errorReportingPreference: errorReportingEnabled ? "enabled" : "disabled",
      analyticsPreference: analyticsEnabled ? "enabled" : "disabled",
      disclosureShown: true,
    });
    const handoff = createObservabilityHandoff();
    process.env[P_DEV_OBSERVABILITY_NONCE_ENV] = handoff.nonce;
    await beginObservabilitySession({
      workspaceDir,
      env: {
        ...packagedEnv,
        ...observabilityHandoffEnv(handoff),
      },
      fakeRecorder: recorder,
    });
    return { recorder, handoff };
  }

  it("persists a successful preference write", async () => {
    const { handoff } = await startSessionWithConsent();
    const response = await POST(
      buildPreferencesRequest({
        nonce: handoff.nonce,
        body: {
          errorReportingPreference: "enabled",
          analyticsPreference: "disabled",
          disclosureShown: true,
        },
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      disclosureShown: boolean;
      errorReportingPreference: string;
      analyticsPreference: string | null;
    };
    expect(payload.disclosureShown).toBe(true);
    expect(payload.errorReportingPreference).toBe("enabled");
    expect(payload.analyticsPreference).toBe("disabled");
  });

  it("captures exactly one product error when preference persistence fails", async () => {
    const { recorder, handoff } = await startSessionWithConsent();
    await blockHarnessPersistence();

    const response = await POST(
      buildPreferencesRequest({
        nonce: handoff.nonce,
        body: {
          errorReportingPreference: "enabled",
          analyticsPreference: "disabled",
          disclosureShown: false,
        },
      }),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Could not save observability preferences.");
    expect(JSON.stringify(payload)).not.toContain("EEXIST");
    expect(JSON.stringify(payload)).not.toContain(workspaceDir);
    expect(recorder.sentryEvents).toHaveLength(1);
    expect(recorder.sentryEvents[0]?.tags?.product_error_code).toBe(
      "configure_request_error",
    );
    expect(recorder.sentryEvents[0]?.tags?.lifecycle_phase).toBe(
      "configure_route",
    );
    expect(recorder.sentryEvents[0]?.tags?.error_category).toBe("unexpected");
    expect(recorder.sentryEvents[0]?.fingerprint).toEqual([
      "configure_request_error",
      "configure_route",
    ]);
  });

  it("keeps consent unchanged after a failed preference write", async () => {
    const { handoff } = await startSessionWithConsent();
    await blockHarnessPersistence();

    await POST(
      buildPreferencesRequest({
        nonce: handoff.nonce,
        body: {
          errorReportingPreference: "enabled",
          analyticsPreference: "disabled",
          disclosureShown: false,
        },
      }),
    );

    const session = getActiveObservabilitySession();
    expect(session?.consent.errorReportingEnabled).toBe(true);
    expect(session?.consent.analyticsEnabled).toBe(false);
    expect(session?.localState.errorReportingPreference).toBe("enabled");
    expect(session?.localState.analyticsPreference).toBe("disabled");
  });

  it("does not capture when error reporting consent is disabled", async () => {
    const { recorder, handoff } = await startSessionWithConsent({
      errorReportingEnabled: false,
    });
    await blockHarnessPersistence();

    const response = await POST(
      buildPreferencesRequest({
        nonce: handoff.nonce,
        body: {
          errorReportingPreference: "disabled",
          analyticsPreference: "disabled",
          disclosureShown: true,
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(recorder.sentryEvents).toHaveLength(0);
  });

  it("keeps reset behavior unchanged and successful reset still works", async () => {
    const { handoff } = await startSessionWithConsent();
    await writeFile(
      path.join(workspaceDir, ".harness", "observability.local.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          analyticsPreference: "enabled",
          errorReportingPreference: "enabled",
          disclosureShown: true,
          installationId: "install-123",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    const response = await POST(
      buildPreferencesRequest({
        nonce: handoff.nonce,
        body: { reset: true },
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      analyticsPreference: null;
      errorReportingPreference: null;
      hasInstallationId: boolean;
    };
    expect(payload.analyticsPreference).toBeNull();
    expect(payload.errorReportingPreference).toBeNull();
    expect(payload.hasInstallationId).toBe(false);
  });

  it("emits only allowlisted tags and sanitized exception metadata on capture", async () => {
    const { recorder, handoff } = await startSessionWithConsent();
    await blockHarnessPersistence();

    await POST(
      buildPreferencesRequest({
        nonce: handoff.nonce,
        body: {
          errorReportingPreference: "enabled",
          analyticsPreference: "disabled",
          disclosureShown: false,
        },
      }),
    );

    const event = recorder.sentryEvents[0]!;
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(workspaceDir);
    expect(serialized).not.toContain(handoff.nonce);
    for (const key of Object.keys(event.tags ?? {})) {
      expect(ALLOWED_SENTRY_TAG_KEYS).toContain(key);
    }
    const exceptionValue = event.exception?.values?.[0]?.value ?? "";
    expect(exceptionValue).not.toContain(workspaceDir);
  });

  it("does not double-capture when the route handles the failure", async () => {
    const { recorder, handoff } = await startSessionWithConsent();
    await blockHarnessPersistence();

    const response = await POST(
      buildPreferencesRequest({
        nonce: handoff.nonce,
        body: {
          errorReportingPreference: "enabled",
          analyticsPreference: "disabled",
          disclosureShown: false,
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(recorder.sentryEvents).toHaveLength(1);
  });

  it("serves GET preferences without mutation", async () => {
    const { handoff } = await startSessionWithConsent();
    const response = await GET(
      buildPreferencesRequest({
        method: "GET",
        nonce: handoff.nonce,
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      errorReportingPreference: string;
    };
    expect(payload.errorReportingPreference).toBe("enabled");
  });
});
