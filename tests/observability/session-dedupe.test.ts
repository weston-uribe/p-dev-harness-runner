import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginObservabilitySession,
  captureAnalyticsEvent,
  createObservabilityTestRecorder,
  registerDisplayedConfigureStep,
  shutdownObservability,
  writeObservabilityPreferences,
} from "../../src/observability/facade.js";
import { resetAnalyticsSessionDedupeForTests } from "../../src/observability/session-dedupe.js";

const tempDirs: string[] = [];

afterEach(async () => {
  resetAnalyticsSessionDedupeForTests();
  await shutdownObservability();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "p-dev-obs-dedupe-"));
  tempDirs.push(dir);
  return dir;
}

const packagedEnv = {
  P_DEV_RUNTIME_MODE: "packaged",
  P_DEV_PACKAGE_VERSION: "0.4.0",
};

describe("analytics session dedupe", () => {
  it("dedupes duplicate step views and setup completion in one process session", async () => {
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

    const stepView = {
      type: "p_dev_configure_step_viewed" as const,
      stepId: "connect-services",
      stepNumber: 1,
      resumed: false as const,
      revisited: false as const,
    };
    captureAnalyticsEvent(stepView);
    captureAnalyticsEvent(stepView);
    captureAnalyticsEvent({ type: "p_dev_setup_completed" });
    captureAnalyticsEvent({ type: "p_dev_setup_completed" });

    const events = recorder.analyticsEvents.map((entry) => entry.event);
    expect(events.filter((event) => event === "p_dev_configure_step_viewed"))
      .toHaveLength(1);
    expect(events.filter((event) => event === "p_dev_setup_completed")).toHaveLength(
      1,
    );
  });

  it("emits session started once across disable and re-enable", async () => {
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

    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "disabled",
    });
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
    });

    const sessionStarts = recorder.analyticsEvents.filter(
      (entry) => entry.event === "p_dev_session_started",
    );
    expect(sessionStarts).toHaveLength(1);
  });

  it("records the displayed configure step once when analytics is enabled mid-session", async () => {
    const recorder = createObservabilityTestRecorder();
    const workspaceDir = await makeWorkspace();
    await beginObservabilitySession({
      workspaceDir,
      env: packagedEnv,
      fakeRecorder: recorder,
    });

    registerDisplayedConfigureStep("linear-workspace");
    await writeObservabilityPreferences(workspaceDir, {
      analyticsPreference: "enabled",
      disclosureShown: true,
    });

    const stepViews = recorder.analyticsEvents.filter(
      (entry) => entry.event === "p_dev_configure_step_viewed",
    );
    expect(stepViews).toHaveLength(1);
    expect(stepViews[0]?.properties.step_id).toBe("linear-workspace");
  });
});
