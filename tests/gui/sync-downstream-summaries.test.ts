import { describe, expect, it } from "vitest";
import { getLinearSetupCapabilities } from "../../src/setup/linear-setup-client";
import { summarizeLinearWorkspaceStatus } from "../../src/setup/control-plane-readiness";
import { getDispatchTriggerStatuses } from "../../src/setup/linear-status-contract";
import { deriveVercelBridgeReadiness } from "../../src/setup/vercel-bridge-readiness";
import type { SetupGuiViewModel } from "../../src/setup/gui-view-model";
import type { LinearSetupSummary } from "../../src/setup/linear-setup-summary";
import type { VercelSetupSummary } from "../../src/setup/vercel-setup-summary";
import type { RemoteSetupSummary } from "../../src/setup/remote-setup-summary";
import { HARNESS_ACTIONS_SECRET_NAMES } from "../../src/setup/remote-actions";
import {
  syncDownstreamSummariesFromEnvPresence,
  syncLinearSummaryFromEnvPresence,
  syncRemoteSummaryFromEnvPresence,
  syncVercelSummaryFromEnvPresence,
  VERCEL_MISSING_TOKEN_GATE_MESSAGE,
  vercelBridgeShowsMissingTokenGate,
} from "../../src/setup/sync-downstream-summaries";

function envKeyPresence(
  partial: Partial<SetupGuiViewModel["envKeyPresence"]> = {},
): SetupGuiViewModel["envKeyPresence"] {
  return {
    HARNESS_CONFIG_PATH: false,
    LINEAR_API_KEY: false,
    CURSOR_API_KEY: false,
    GITHUB_TOKEN: false,
    VERCEL_TOKEN: false,
    ...partial,
  };
}

function baseLinearSummary(
  overrides: Partial<LinearSetupSummary> = {},
): LinearSetupSummary {
  return {
    capabilities: getLinearSetupCapabilities(),
    controlPlane: null,
    workspace: summarizeLinearWorkspaceStatus({ state: null }),
    dispatchTriggerStatuses: getDispatchTriggerStatuses(),
    linearApiKeyConfigured: false,
    ...overrides,
  };
}

function baseVercelSummary(
  overrides: Partial<VercelSetupSummary> = {},
): VercelSetupSummary {
  return {
    controlPlane: null,
    vercelTokenConfigured: false,
    linearApiKeyConfigured: false,
    readiness: deriveVercelBridgeReadiness({}),
    ...overrides,
  };
}

function baseRemoteSummary(
  overrides: Partial<RemoteSetupSummary> = {},
): RemoteSetupSummary {
  return {
    githubTokenConfigured: false,
    harnessDispatchRepo: "<harness-dispatch-repo>",
    harnessDispatchRepoResolved: false,
    harnessDispatchRepoSource: "unresolved",
    harnessRepoAccess: "unknown",
    requireVercelProductionToken: false,
    harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
      name,
      status: "missing" as const,
    })),
    targetRepos: [],
    staleSmokeDiagnostics: {
      staleHarnessDispatchRepo: false,
      staleTargetRepos: [],
    },
    ...overrides,
  };
}

describe("sync-downstream-summaries", () => {
  it("shows the Vercel missing-token gate before Step 1 save", () => {
    const preSave = baseVercelSummary({ vercelTokenConfigured: false });

    expect(vercelBridgeShowsMissingTokenGate(preSave)).toBe(true);
    expect(VERCEL_MISSING_TOKEN_GATE_MESSAGE).toMatch(/VERCEL_TOKEN/);
  });

  it("clears the Vercel missing-token gate after Step 1 returns VERCEL_TOKEN presence", () => {
    const preSave = baseVercelSummary({
      vercelTokenConfigured: false,
      linearApiKeyConfigured: false,
    });

    const synced = syncVercelSummaryFromEnvPresence(
      preSave,
      envKeyPresence({
        VERCEL_TOKEN: true,
        LINEAR_API_KEY: true,
      }),
    );

    expect(vercelBridgeShowsMissingTokenGate(synced)).toBe(false);
    expect(synced.vercelTokenConfigured).toBe(true);
    expect(synced.linearApiKeyConfigured).toBe(true);
  });

  it("propagates all local service key presence flags to downstream summaries", () => {
    const presence = envKeyPresence({
      LINEAR_API_KEY: true,
      CURSOR_API_KEY: true,
      GITHUB_TOKEN: true,
      VERCEL_TOKEN: true,
    });

    const synced = syncDownstreamSummariesFromEnvPresence({
      envKeyPresence: presence,
      linearSummary: baseLinearSummary(),
      vercelSummary: baseVercelSummary(),
      remoteSummary: baseRemoteSummary(),
    });

    expect(synced.linearSummary.linearApiKeyConfigured).toBe(true);
    expect(synced.vercelSummary.vercelTokenConfigured).toBe(true);
    expect(synced.vercelSummary.linearApiKeyConfigured).toBe(true);
    expect(synced.remoteSummary.githubTokenConfigured).toBe(true);
    expect(
      synced.remoteSummary.harnessSecretStatuses.find(
        (entry) => entry.name === "HARNESS_GITHUB_TOKEN",
      )?.status,
    ).toBe("unknown");
    expect(
      synced.remoteSummary.harnessSecretStatuses.find(
        (entry) => entry.name === "LINEAR_API_KEY",
      )?.status,
    ).toBe("unknown");
    expect(
      synced.remoteSummary.harnessSecretStatuses.find(
        (entry) => entry.name === "CURSOR_API_KEY",
      )?.status,
    ).toBe("unknown");
  });

  it("preserves non-credential summary fields while syncing presence", () => {
    const linear = baseLinearSummary({
      linearApiKeyConfigured: false,
      controlPlane: {
        version: 1,
        linear: { teamId: "team-1", teamKey: "WES" },
      },
    });

    const synced = syncLinearSummaryFromEnvPresence(
      linear,
      envKeyPresence({ LINEAR_API_KEY: true }),
    );

    expect(synced.linearApiKeyConfigured).toBe(true);
    expect(synced.controlPlane?.linear?.teamKey).toBe("WES");
    expect(synced.capabilities).toEqual(getLinearSetupCapabilities());
  });

  it("does not mark cloud-present harness secrets as unknown when syncing", () => {
    const remote = baseRemoteSummary({
      harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
        name,
        status: name === "HARNESS_GITHUB_TOKEN" ? ("present" as const) : ("missing" as const),
      })),
    });

    const synced = syncRemoteSummaryFromEnvPresence(
      remote,
      envKeyPresence({ GITHUB_TOKEN: true }),
    );

    expect(
      synced.harnessSecretStatuses.find(
        (entry) => entry.name === "HARNESS_GITHUB_TOKEN",
      )?.status,
    ).toBe("present");
  });

  it("does not leak secret values in serialized sync output", () => {
    const synced = syncDownstreamSummariesFromEnvPresence({
      envKeyPresence: envKeyPresence({
        LINEAR_API_KEY: true,
        VERCEL_TOKEN: true,
      }),
      linearSummary: baseLinearSummary(),
      vercelSummary: baseVercelSummary(),
      remoteSummary: baseRemoteSummary(),
    });

    const serialized = JSON.stringify(synced);
    expect(serialized).not.toContain("fake-linear");
    expect(serialized).not.toContain("fake-vercel");
    expect(serialized).not.toMatch(/lin_api_[A-Za-z0-9]+/);
  });
});
