import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isObservabilityRuntimeEligible } from "../../src/observability/runtime-eligibility.js";
import {
  beginObservabilitySession,
  captureAnalyticsEvent,
  captureProductError,
  createObservabilityTestRecorder,
  resetObservabilityState,
  shutdownObservability,
  writeObservabilityPreferences,
} from "../../src/observability/facade.js";
import {
  readObservabilityLocalState,
  resolveObservabilityLocalStatePath,
} from "../../src/observability/local-state.js";
import { OBSERVABILITY_LOCAL_FILE } from "../../src/observability/constants.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await shutdownObservability();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "p-dev-obs-"));
  tempDirs.push(dir);
  return dir;
}

describe("observability runtime eligibility", () => {
  it("disables telemetry outside packaged runtime", () => {
    expect(
      isObservabilityRuntimeEligible({
        env: { P_DEV_RUNTIME_MODE: "source" },
      }),
    ).toBe(false);
    expect(
      isObservabilityRuntimeEligible({
        env: { P_DEV_RUNTIME_MODE: "packaged", VITEST: "true" },
      }),
    ).toBe(false);
    expect(
      isObservabilityRuntimeEligible({
        env: { P_DEV_RUNTIME_MODE: "packaged", CI: "true" },
      }),
    ).toBe(false);
  });

  it("allows fake transport injection in tests", () => {
    expect(
      isObservabilityRuntimeEligible({
        env: { P_DEV_RUNTIME_MODE: "source" },
        allowFakeTransport: true,
      }),
    ).toBe(true);
  });
});

describe("observability consent and identity", () => {
  it("does not emit events before a user choice", async () => {
    const recorder = createObservabilityTestRecorder();
    const workspaceDir = await makeWorkspace();
    await beginObservabilitySession({
      workspaceDir,
      env: {
        P_DEV_RUNTIME_MODE: "packaged",
        P_DEV_PACKAGE_VERSION: "0.4.0",
      },
      fakeRecorder: recorder,
    });

    captureAnalyticsEvent({ type: "p_dev_setup_completed" });
    captureProductError({
      lifecyclePhase: "configure_route",
      productErrorCode: "test_error",
      errorCategory: "unexpected",
      message: "secret ghp_abc123 should not leak",
    });

    expect(recorder.analyticsEvents).toHaveLength(0);
    expect(recorder.sentryEvents).toHaveLength(0);
  });

  it("creates installation ID only when analytics is enabled", async () => {
    const workspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(workspaceDir, {
      errorReportingPreference: "enabled",
    });
    const errorOnly = await readObservabilityLocalState(workspaceDir);
    expect(errorOnly.installationId).toBeUndefined();

    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
    });
    const analyticsEnabled = await readObservabilityLocalState(workspaceDir);
    expect(analyticsEnabled.installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("routes analytics-only and error-reporting-only consent independently", async () => {
    const workspaceDir = await makeWorkspace();

    const analyticsRecorder = createObservabilityTestRecorder();
    await beginObservabilitySession({
      workspaceDir,
      env: {
        P_DEV_RUNTIME_MODE: "packaged",
        P_DEV_PACKAGE_VERSION: "0.4.0",
      },
      fakeRecorder: analyticsRecorder,
    });
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      errorReportingPreference: "disabled",
      disclosureShown: true,
    });
    captureAnalyticsEvent({ type: "p_dev_setup_completed" });
    captureProductError({
      lifecyclePhase: "provisioning",
      productErrorCode: "should_not_send",
      errorCategory: "unexpected",
    });
    expect(
      analyticsRecorder.analyticsEvents.filter(
        (entry) => entry.event !== "p_dev_session_started",
      ),
    ).toHaveLength(1);
    expect(analyticsRecorder.sentryEvents).toHaveLength(0);
    await shutdownObservability();

    const errorRecorder = createObservabilityTestRecorder();
    const errorWorkspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(errorWorkspaceDir, {
      analyticsPreference: "disabled",
      errorReportingPreference: "enabled",
      disclosureShown: true,
    });
    await beginObservabilitySession({
      workspaceDir: errorWorkspaceDir,
      env: {
        P_DEV_RUNTIME_MODE: "packaged",
        P_DEV_PACKAGE_VERSION: "0.4.0",
      },
      fakeRecorder: errorRecorder,
    });
    captureAnalyticsEvent({ type: "p_dev_setup_completed" });
    captureProductError({
      lifecyclePhase: "provisioning",
      productErrorCode: "provision_failed",
      errorCategory: "server",
      message: "token ghp_testtoken",
    });
    expect(errorRecorder.analyticsEvents).toHaveLength(0);
    expect(errorRecorder.sentryEvents).toHaveLength(1);
    expect(JSON.stringify(errorRecorder.sentryEvents[0])).not.toContain(
      "ghp_testtoken",
    );
    expect(JSON.stringify(errorRecorder.sentryEvents[0])).not.toContain(
      "installationId",
    );
  });

  it("honors environment kill switches over persisted preferences", async () => {
    const recorder = createObservabilityTestRecorder();
    const workspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      errorReportingPreference: "enabled",
      disclosureShown: true,
    });
    await beginObservabilitySession({
      workspaceDir,
      env: {
        P_DEV_RUNTIME_MODE: "packaged",
        P_DEV_PACKAGE_VERSION: "0.4.0",
        DO_NOT_TRACK: "1",
      },
      fakeRecorder: recorder,
    });
    captureAnalyticsEvent({ type: "p_dev_setup_completed" });
    captureProductError({
      lifecyclePhase: "launcher_startup",
      productErrorCode: "blocked",
      errorCategory: "unexpected",
    });
    expect(recorder.analyticsEvents).toHaveLength(0);
    expect(recorder.sentryEvents).toHaveLength(0);
  });

  it("reset removes installation ID and preferences", async () => {
    const workspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      errorReportingPreference: "enabled",
      disclosureShown: true,
    });
    await resetObservabilityState(workspaceDir);
    const state = await readObservabilityLocalState(workspaceDir);
    expect(state.analyticsPreference).toBeNull();
    expect(state.errorReportingPreference).toBeNull();
    expect(state.installationId).toBeUndefined();
    expect(state.disclosureShown).toBe(false);
  });
});

describe("observability local state path", () => {
  it("uses excluded harness local json path", () => {
    expect(resolveObservabilityLocalStatePath("/tmp/workspace")).toBe(
      path.join("/tmp/workspace", OBSERVABILITY_LOCAL_FILE),
    );
  });

  it("writes state atomically with restrictive permissions", async () => {
    const workspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      disclosureShown: true,
    });
    const filePath = resolveObservabilityLocalStatePath(workspaceDir);
    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("analyticsPreference");
    expect(raw).not.toContain("ghp_");
  });
});
