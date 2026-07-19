import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OBSERVABILITY_FLUSH_DEADLINE_MS,
  P_DEV_OBSERVABILITY_NONCE_ENV,
  P_DEV_OBSERVABILITY_SESSION_ID_ENV,
} from "../../src/observability/constants.js";
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
  createFakeAnalyticsTransport,
  createFakeErrorTransport,
} from "../../src/observability/adapters/fake.js";
import {
  createObservabilityHandoff,
  observabilityHandoffEnv,
  resolveObservabilityHandoff,
} from "../../src/observability/session-handoff.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await shutdownObservability();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "p-dev-obs-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

const packagedEnv = {
  P_DEV_RUNTIME_MODE: "packaged",
  P_DEV_PACKAGE_VERSION: "0.4.0",
};

describe("observability session handoff primitives", () => {
  it("creates and resolves a shared session id and nonce from env", () => {
    const handoff = createObservabilityHandoff();
    const env = observabilityHandoffEnv(handoff);
    const resolved = resolveObservabilityHandoff(env);
    expect(resolved.sessionId).toBe(handoff.sessionId);
    expect(resolved.nonce).toBe(handoff.nonce);
    expect(env[P_DEV_OBSERVABILITY_SESSION_ID_ENV]).toBe(handoff.sessionId);
    expect(env[P_DEV_OBSERVABILITY_NONCE_ENV]).toBe(handoff.nonce);
  });

  it("uses env-provided session id when child process starts", async () => {
    const handoff = createObservabilityHandoff();
    const workspaceDir = await makeWorkspace();
    const session = await beginObservabilitySession({
      workspaceDir,
      env: {
        ...packagedEnv,
        ...observabilityHandoffEnv(handoff),
      },
      fakeRecorder: createObservabilityTestRecorder(),
    });
    expect(session?.sessionId).toBe(handoff.sessionId);
    expect(session?.nonce).toBe(handoff.nonce);
  });
});

describe("observability transport lifecycle", () => {
  it("disables analytics independently without disturbing error reporting", async () => {
    const recorder = createObservabilityTestRecorder();
    const workspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      errorReportingPreference: "enabled",
      disclosureShown: true,
    });
    await beginObservabilitySession({
      workspaceDir,
      env: packagedEnv,
      fakeRecorder: recorder,
    });

    captureAnalyticsEvent({ type: "p_dev_setup_completed" });
    captureProductError({
      lifecyclePhase: "configure_route",
      productErrorCode: "before_disable",
      errorCategory: "unexpected",
    });
    expect(
      recorder.analyticsEvents.filter(
        (entry) => entry.event !== "p_dev_session_started",
      ),
    ).toHaveLength(1);
    expect(recorder.sentryEvents).toHaveLength(1);

    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "disabled",
    });

    captureAnalyticsEvent({ type: "p_dev_setup_completed" });
    captureProductError({
      lifecyclePhase: "configure_route",
      productErrorCode: "after_analytics_disable",
      errorCategory: "unexpected",
    });
    expect(
      recorder.analyticsEvents.filter(
        (entry) => entry.event !== "p_dev_session_started",
      ),
    ).toHaveLength(1);
    expect(recorder.sentryEvents).toHaveLength(2);
  });

  it("disables error reporting independently without disturbing analytics", async () => {
    const recorder = createObservabilityTestRecorder();
    const workspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      errorReportingPreference: "enabled",
      disclosureShown: true,
    });
    await beginObservabilitySession({
      workspaceDir,
      env: packagedEnv,
      fakeRecorder: recorder,
    });

    await writeObservabilityPreferences(workspaceDir, {
      errorReportingPreference: "disabled",
    });

    captureAnalyticsEvent({ type: "p_dev_setup_completed" });
    captureProductError({
      lifecyclePhase: "configure_route",
      productErrorCode: "should_not_send",
      errorCategory: "unexpected",
    });
    expect(
      recorder.analyticsEvents.filter(
        (entry) => entry.event !== "p_dev_session_started",
      ),
    ).toHaveLength(1);
    expect(recorder.sentryEvents).toHaveLength(0);
  });

  it("reset drops both categories before clearing identity", async () => {
    const recorder = createObservabilityTestRecorder();
    const workspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      errorReportingPreference: "enabled",
      disclosureShown: true,
    });
    await beginObservabilitySession({
      workspaceDir,
      env: packagedEnv,
      fakeRecorder: recorder,
    });

    await resetObservabilityState(workspaceDir);

    const analyticsCountBefore = recorder.analyticsEvents.length;
    const sentryCountBefore = recorder.sentryEvents.length;
    captureAnalyticsEvent({ type: "p_dev_setup_completed" });
    captureProductError({
      lifecyclePhase: "configure_route",
      productErrorCode: "after_reset",
      errorCategory: "unexpected",
    });
    expect(recorder.analyticsEvents).toHaveLength(analyticsCountBefore);
    expect(recorder.sentryEvents).toHaveLength(sentryCountBefore);
  });

  it("closes the analytics gate before disposal and blocks new initiations", async () => {
    const initiated: number[] = [];
    const completed: number[] = [];
    const recorder = createObservabilityTestRecorder();
    const workspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      disclosureShown: true,
    });
    await beginObservabilitySession({
      workspaceDir,
      env: packagedEnv,
      fakeRecorder: {
        ...recorder,
        analyticsEvents: recorder.analyticsEvents,
      },
    });

    const delayedRecorder = createObservabilityTestRecorder();
    const delayedTransport = createFakeAnalyticsTransport({
      recorder: delayedRecorder,
      sendDelayMs: 100,
      onRequestInitiated: (timestamp) => initiated.push(timestamp),
      onRequestCompleted: (timestamp) => completed.push(timestamp),
    });

    delayedTransport.capture({
      event: "p_dev_setup_completed",
      properties: { distinct_id: "test" },
    });

    const disableStarted = Date.now();
    await delayedTransport.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS);
    const disableFinished = Date.now();

    delayedTransport.capture({
      event: "p_dev_setup_completed",
      properties: { distinct_id: "test" },
    });

    expect(initiated.length).toBeLessThanOrEqual(1);
    expect(delayedRecorder.analyticsEvents.length).toBeLessThanOrEqual(1);
    expect(disableFinished - disableStarted).toBeLessThan(
      OBSERVABILITY_FLUSH_DEADLINE_MS + 500,
    );
  });

  it("supports rapid enable-disable-enable without reviving old adapter state", async () => {
    const recorder = createObservabilityTestRecorder();
    const workspaceDir = await makeWorkspace();
    await beginObservabilitySession({
      workspaceDir,
      env: packagedEnv,
      fakeRecorder: recorder,
    });

    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      disclosureShown: true,
    });
    captureAnalyticsEvent({ type: "p_dev_setup_completed" });

    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "disabled",
    });
    captureAnalyticsEvent({ type: "p_dev_setup_completed" });

    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
    });
    captureAnalyticsEvent({ type: "p_dev_setup_completed" });

    expect(recorder.analyticsEvents).toHaveLength(2);
  });

  it("does not return preference disable until in-flight analytics work settles", async () => {
    const initiated: number[] = [];
    const completed: number[] = [];
    const recorder = createObservabilityTestRecorder();
    const workspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      disclosureShown: true,
    });
    await beginObservabilitySession({
      workspaceDir,
      env: packagedEnv,
      fakeRecorder: recorder,
    });

    const transport = createFakeAnalyticsTransport({
      recorder,
      sendDelayMs: 50,
      onRequestInitiated: (timestamp) => initiated.push(timestamp),
      onRequestCompleted: (timestamp) => completed.push(timestamp),
    });
    transport.capture({
      event: "p_dev_setup_completed",
      properties: { distinct_id: "test" },
    });

    const disableStarted = Date.now();
    await transport.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS);
    const disableFinished = Date.now();

    expect(initiated.length).toBe(1);
    expect(completed.length).toBeLessThanOrEqual(1);
    expect(disableFinished - disableStarted).toBeLessThan(
      OBSERVABILITY_FLUSH_DEADLINE_MS + 500,
    );
  });

  it("drops queued analytics events on disable without later collector receipt", async () => {
    const initiated: number[] = [];
    const completed: number[] = [];
    const recorder = createObservabilityTestRecorder();
    const transport = createFakeAnalyticsTransport({
      recorder,
      sendDelayMs: 200,
      onRequestInitiated: (timestamp) => initiated.push(timestamp),
      onRequestCompleted: (timestamp) => completed.push(timestamp),
    });

    transport.capture({
      event: "p_dev_setup_completed",
      properties: { distinct_id: "queued" },
    });
    await transport.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(recorder.analyticsEvents).toHaveLength(0);
    expect(initiated.length).toBeLessThanOrEqual(1);
  });

  it("waits for pending error transport work during disable", async () => {
    const initiated: number[] = [];
    const recorder = createObservabilityTestRecorder();
    const transport = createFakeErrorTransport({
      recorder,
      sendDelayMs: 50,
      onRequestInitiated: (timestamp) => initiated.push(timestamp),
    });

    transport.captureError(
      {
        lifecyclePhase: "configure_route",
        productErrorCode: "pending_error",
        errorCategory: "unexpected",
      },
      {
        observability_schema_version: 1,
        package_version: "0.4.0",
        release_sha: "abc",
        session_id: "session",
        runtime_mode: "packaged",
        os_family: "linux",
        cpu_arch_family: "x64",
        node_major_version: 22,
        lifecycle_phase: "configure_route",
      },
    );

    await transport.disableAndDrop(OBSERVABILITY_FLUSH_DEADLINE_MS);
    expect(initiated.length).toBe(1);
    expect(recorder.sentryEvents.length).toBeLessThanOrEqual(1);
  });
});
