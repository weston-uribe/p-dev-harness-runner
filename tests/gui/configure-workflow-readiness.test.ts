import { describe, expect, it } from "vitest";
import {
  isServiceConnectionReady,
  shouldAutoReverifySavedService,
} from "../../apps/gui/components/custom/configure-workflow";
import { serviceVerificationFromSummaries } from "../../apps/gui/lib/verification-state.js";
import type {
  EnvironmentFormPresence,
  EnvironmentFormValues,
  ServiceKey,
} from "../../apps/gui/components/custom/environment-config-form";
import type { ServiceConnectionSummaryMap } from "../../apps/gui/lib/setup-server";

const allServiceKeys: ServiceKey[] = [
  "LINEAR_API_KEY",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "VERCEL_TOKEN",
];

function presence(value: boolean): EnvironmentFormPresence {
  return {
    LINEAR_API_KEY: value,
    CURSOR_API_KEY: value,
    GITHUB_TOKEN: value,
    VERCEL_TOKEN: value,
  };
}

const blankEnv: EnvironmentFormValues = {
  harnessConfigPath: ".harness/config.local.json",
  githubDispatchRepository: "",
  linearApiKey: "",
  cursorApiKey: "",
  githubToken: "",
  vercelToken: "",
};

function summaries(
  status: ServiceConnectionSummaryMap[ServiceKey]["status"],
): ServiceConnectionSummaryMap {
  return {
    LINEAR_API_KEY: { status, message: `${status} linear` },
    CURSOR_API_KEY: { status, message: `${status} cursor` },
    GITHUB_TOKEN: { status, message: `${status} github` },
    VERCEL_TOKEN: { status, message: `${status} vercel` },
  };
}

describe("ConfigureWorkflow service readiness", () => {
  it("seeds saved connected credentials without auto reverify", () => {
    const seeded = serviceVerificationFromSummaries(summaries("connected"));

    expect(
      allServiceKeys.every((key) =>
        isServiceConnectionReady({
          key,
          presence: presence(true),
          verification: seeded,
          envValues: blankEnv,
        }),
      ),
    ).toBe(true);
    expect(
      allServiceKeys.some((key) =>
        shouldAutoReverifySavedService({
          key,
          presence: presence(true),
          envValues: blankEnv,
          summaries: summaries("connected"),
          verification: seeded,
        }),
      ),
    ).toBe(false);
  });

  it("auto reverifies only missing stale or unknown saved summaries", () => {
    for (const status of ["missing", "unknown", "stale"] as const) {
      const seeded = serviceVerificationFromSummaries(summaries(status));
      expect(
        shouldAutoReverifySavedService({
          key: "GITHUB_TOKEN",
          presence: presence(true),
          envValues: blankEnv,
          summaries: summaries(status),
          verification: seeded,
        }),
      ).toBe(true);
    }

    for (const status of ["connected", "failed"] as const) {
      const seeded = serviceVerificationFromSummaries(summaries(status));
      expect(
        shouldAutoReverifySavedService({
          key: "GITHUB_TOKEN",
          presence: presence(true),
          envValues: blankEnv,
          summaries: summaries(status),
          verification: seeded,
        }),
      ).toBe(false);
    }
  });

  it("keeps saved failed credentials blocking", () => {
    const seeded = serviceVerificationFromSummaries(summaries("failed"));

    expect(
      isServiceConnectionReady({
        key: "LINEAR_API_KEY",
        presence: presence(true),
        verification: seeded,
        envValues: blankEnv,
      }),
    ).toBe(false);
  });
});
