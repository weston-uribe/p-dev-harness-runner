import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginObservabilitySession,
  captureProductError,
  createObservabilityTestRecorder,
  shutdownObservability,
  writeObservabilityPreferences,
} from "../../src/observability/facade.js";
import { ALLOWED_SENTRY_TAG_KEYS } from "../../src/observability/privacy-schema.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await shutdownObservability();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "p-dev-sentry-"));
  tempDirs.push(dir);
  return dir;
}

describe("observability sentry transport", () => {
  it("groups errors by product code and lifecycle phase only", async () => {
    const recorder = createObservabilityTestRecorder();
    const workspaceDir = await makeWorkspace();
    await writeObservabilityPreferences(workspaceDir, {
      errorReportingPreference: "enabled",
      disclosureShown: true,
    });
    await beginObservabilitySession({
      workspaceDir,
      env: {
        P_DEV_RUNTIME_MODE: "packaged",
        P_DEV_PACKAGE_VERSION: "0.4.0",
      },
      fakeRecorder: recorder,
    });

    captureProductError({
      lifecyclePhase: "provisioning",
      productErrorCode: "provision_failed",
      errorCategory: "server",
    });

    expect(recorder.sentryEvents).toHaveLength(1);
    expect(recorder.sentryEvents[0]?.fingerprint).toEqual([
      "provision_failed",
      "provisioning",
    ]);
  });

  it("never includes installation ID in sentry payloads", async () => {
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
      },
      fakeRecorder: recorder,
    });

    captureProductError({
      lifecyclePhase: "configure_route",
      productErrorCode: "configure_request_error",
      errorCategory: "unexpected",
      message: "token ghp_testtoken",
    });

    const serialized = JSON.stringify(recorder.sentryEvents[0]);
    expect(serialized).not.toContain("installationId");
    expect(serialized).not.toContain("ghp_testtoken");
    for (const key of Object.keys(recorder.sentryEvents[0]?.tags ?? {})) {
      expect(ALLOWED_SENTRY_TAG_KEYS).toContain(key);
    }
  });
});
