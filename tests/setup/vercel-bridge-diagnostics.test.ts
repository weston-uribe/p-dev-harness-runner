import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/setup/vercel-setup-plan.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/setup/vercel-setup-plan.js")>();
  return {
    ...actual,
    previewVercelBridgeSetup: vi.fn(),
  };
});

vi.mock("../../src/setup/control-plane-setup-state.js", () => ({
  readControlPlaneSetupState: vi.fn(),
}));

vi.mock("../../src/setup/service-verification.js", () => ({
  loadSecretFromEnvLocal: vi.fn(),
}));

vi.mock("../../src/setup/github-dispatch-token.js", () => ({
  assessGitHubDispatchTokenEligibility: vi.fn(),
}));

vi.mock("../../src/setup/vercel-setup-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/setup/vercel-setup-client.js")>();
  return {
    ...actual,
    listVercelProductionDeployments: vi.fn(),
    getVercelDeployment: vi.fn(),
    resolveCanonicalProductionTarget: vi.fn(),
  };
});

vi.mock("../../src/setup/linear-setup-client.js", () => ({
  createLinearSetupClient: vi.fn(),
  listLinearWebhooks: vi.fn(),
}));

vi.mock("../../src/setup/vercel-webhook-probe.js", () => ({
  runSignedWebhookProbe: vi.fn(),
}));

import { readControlPlaneSetupState } from "../../src/setup/control-plane-setup-state.js";
import { assessGitHubDispatchTokenEligibility } from "../../src/setup/github-dispatch-token.js";
import { listLinearWebhooks } from "../../src/setup/linear-setup-client.js";
import { loadSecretFromEnvLocal } from "../../src/setup/service-verification.js";
import { buildVercelBridgeDiagnosticReport } from "../../src/setup/vercel-bridge-diagnostics.js";
import {
  getVercelDeployment,
  listVercelProductionDeployments,
  resolveCanonicalProductionTarget,
} from "../../src/setup/vercel-setup-client.js";
import {
  previewVercelBridgeSetup,
  VERCEL_SETUP_ACTIONS,
} from "../../src/setup/vercel-setup-plan.js";
import { runSignedWebhookProbe } from "../../src/setup/vercel-webhook-probe.js";

const previewResult = {
  actionId: VERCEL_SETUP_ACTIONS.preview.id,
  teams: [],
  projects: [{ id: "proj-1", name: "harness-gui", accountId: "acct-1" }],
  selectedProject: { id: "proj-1", name: "harness-gui", accountId: "acct-1" },
  productionUrl: "https://harness-gui.vercel.app",
  webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
  deploymentStatus: "ready" as const,
  endpointReachable: true,
  envWritePlan: [
    { key: "LINEAR_WEBHOOK_SECRET", action: "create", source: "generated" },
  ],
  requiredEnvPresence: {
    LINEAR_WEBHOOK_SECRET: "present",
    GITHUB_DISPATCH_TOKEN: "present",
    HARNESS_TEAM_KEY: "present",
  },
  linearWebhookVerified: true,
  readiness: { ready: false, blockers: [], warnings: [] },
  manualSteps: [],
  fingerprint: "preview-fingerprint",
  permission: VERCEL_SETUP_ACTIONS.preview.permission,
  linearWebhookSecretMode: "automated" as const,
  githubDispatchSource: "saved-github-token" as const,
};

const fingerprintInputs = {
  actionId: VERCEL_SETUP_ACTIONS.preview.id,
  teamId: "team-1",
  teamMode: "existing",
  projectId: "proj-1",
  projectMode: "existing",
  projectName: "harness-gui",
  envWritePlan: [
    { key: "LINEAR_WEBHOOK_SECRET", action: "create", source: "generated" },
  ],
  linearWebhookSecretToken: "generate-on-apply",
  githubDispatchTokenToken: "40:12345",
  harnessTeamKey: "WES",
  vercelTokenToken: "12:67890",
};

describe("vercel-bridge-diagnostics", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "vercel-bridge-diagnostics-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".env.local"),
      [
        "LINEAR_API_KEY=lin_api_test_secret_value",
        "GITHUB_TOKEN=ghp_test_secret_value",
        "VERCEL_TOKEN=vercel_test_secret_value",
        "LINEAR_WEBHOOK_SECRET=generated-webhook-secret-value",
      ].join("\n"),
      "utf8",
    );

    vi.clearAllMocks();
    vi.mocked(loadSecretFromEnvLocal).mockImplementation(async ({ key }) => {
      if (key === "VERCEL_TOKEN") return "vercel_test_secret_value";
      if (key === "LINEAR_API_KEY") return "lin_api_test_secret_value";
      if (key === "GITHUB_TOKEN") return "ghp_test_secret_value";
      if (key === "LINEAR_WEBHOOK_SECRET") return "generated-webhook-secret-value";
      return undefined;
    });
    vi.mocked(assessGitHubDispatchTokenEligibility).mockResolvedValue({
      eligible: true,
      reason: "eligible",
      repository: "weston-uribe/agentic-product-development-harness",
    });
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue(previewResult);
    vi.mocked(resolveCanonicalProductionTarget).mockResolvedValue({
      productionUrl: "https://harness-gui.vercel.app",
      webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
      deploymentId: "dpl-latest",
      deploymentUrl:
        "agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app",
      source: "stable_alias",
      stableAlias: "harness-gui.vercel.app",
      readyState: "READY",
      state: "READY",
    });
    vi.mocked(listVercelProductionDeployments).mockResolvedValue([
      {
        id: "dpl-latest",
        url: "agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app",
        state: "READY",
        readyState: "READY",
        aliases: ["harness-gui.vercel.app"],
      },
    ]);
    vi.mocked(getVercelDeployment).mockResolvedValue({
      id: "dpl-new-1",
      url: "harness-gui-new.vercel.app",
      state: "READY",
      readyState: "READY",
    });
    vi.mocked(listLinearWebhooks).mockResolvedValue([
      {
        id: "wh-1",
        url: "https://harness-gui.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
        teamId: "linear-team-1",
        secret: undefined,
      },
    ]);
    vi.mocked(readControlPlaneSetupState).mockResolvedValue({
      version: 1,
      linear: {
        teamId: "linear-team-1",
        teamKey: "WES",
        teamName: "Weston",
        teamMode: "existing",
        projectMode: "existing",
        projectName: "Harness",
        statusCoverageComplete: true,
      },
      vercel: {
        teamId: "team-1",
        projectId: "proj-1",
        projectName: "harness-gui",
        productionUrl: "https://harness-gui.vercel.app",
        webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
        endpointReachable: true,
        envVarPresence: {
          LINEAR_WEBHOOK_SECRET: "present",
          GITHUB_DISPATCH_TOKEN: "present",
          HARNESS_TEAM_KEY: "present",
        },
        linearWebhookVerified: true,
        signedProbeVerified: false,
        signedProbe: {
          passed: false,
          result: "auth_failed",
          reason: "invalid_signature",
          statusCode: 401,
          probedAt: new Date().toISOString(),
        },
        deploymentRedeployRequired: true,
        appliedFingerprint: "preview-fingerprint",
        redeployVerification: {
          actionId: "vercel-redeploy-test",
          projectId: "proj-1",
          projectName: "harness-gui",
          teamId: "team-1",
          webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
          fingerprint: "preview-fingerprint",
          fingerprintInputs,
          candidateSecretSource: "generated",
          sourceDeploymentId: "dpl-source-1",
          newDeploymentId: "dpl-new-1",
          status: "verify_failed",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deadlineAt: new Date(Date.now() + 300_000).toISOString(),
          verifyAttempted: true,
          blockedMessage:
            "Production redeploy completed, but signed webhook delivery verification still failed (invalid_signature).",
          blockedNextSteps: ["Use Retry verification without rewriting env vars or rotating secrets."],
          writtenEnvKeys: ["LINEAR_WEBHOOK_SECRET"],
          skippedEnvKeys: ["GITHUB_DISPATCH_TOKEN"],
        },
      },
    });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("defaults to read-only diagnostics without live probe", async () => {
    const report = await buildVercelBridgeDiagnosticReport({ cwd: tempRoot });

    expect(report.signedProbeDiagnostic.liveProbeExecuted).toBe(false);
    expect(report.signedProbeDiagnostic.persistedProbe?.reason).toBe(
      "invalid_signature",
    );
    expect(runSignedWebhookProbe).not.toHaveBeenCalled();
  });

  it("runs live probe only when explicitly requested", async () => {
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      statusCode: 401,
      probedAt: new Date().toISOString(),
    });

    const report = await buildVercelBridgeDiagnosticReport({
      cwd: tempRoot,
      liveProbe: true,
    });

    expect(report.signedProbeDiagnostic.liveProbeExecuted).toBe(true);
    expect(runSignedWebhookProbe).toHaveBeenCalledTimes(1);
    expect(report.signedProbeDiagnostic.liveProbe?.reason).toBe("invalid_signature");
  });

  it("includes fingerprint mismatch evidence when reconstructed preview drifts", async () => {
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue({
      ...previewResult,
      fingerprint: "different-fingerprint",
      envWritePlan: [
        { key: "HARNESS_TEAM_KEY", action: "update", source: "derived" },
      ],
    });

    const report = await buildVercelBridgeDiagnosticReport({ cwd: tempRoot });

    expect(report.reconstructedPollVerifyPreview?.reconstructionSucceeded).toBe(
      true,
    );
    expect(report.reconstructedPollVerifyPreview?.fingerprintsMatch).toBe(false);
    expect(report.reconstructedPollVerifyPreview?.expectedPendingFingerprint).toBe(
      "preview-fingerprint",
    );
    expect(report.reconstructedPollVerifyPreview?.reconstructedFingerprint).toBe(
      "different-fingerprint",
    );
    expect(report.fingerprintComponentDiff?.originalFingerprintInputsAvailable).toBe(
      true,
    );
    expect(report.fingerprintComponentDiff?.differingKeys.length).toBeGreaterThan(0);
  });

  it("reports unavailable original fingerprint inputs for legacy pending state", async () => {
    vi.mocked(readControlPlaneSetupState).mockResolvedValue({
      version: 1,
      vercel: {
        teamId: "team-1",
        projectId: "proj-1",
        projectName: "harness-gui",
        productionUrl: "https://harness-gui.vercel.app",
        webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
        endpointReachable: true,
        envVarPresence: {
          LINEAR_WEBHOOK_SECRET: "present",
          GITHUB_DISPATCH_TOKEN: "present",
          HARNESS_TEAM_KEY: "present",
        },
        linearWebhookVerified: true,
        redeployVerification: {
          actionId: "vercel-redeploy-legacy",
          projectId: "proj-1",
          projectName: "harness-gui",
          webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
          fingerprint: "preview-fingerprint",
          status: "verify_failed",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deadlineAt: new Date(Date.now() + 300_000).toISOString(),
          verifyAttempted: true,
          newDeploymentId: "dpl-new-1",
        },
      },
    });

    const report = await buildVercelBridgeDiagnosticReport({ cwd: tempRoot });

    expect(report.fingerprintComponentDiff?.originalFingerprintInputsAvailable).toBe(
      false,
    );
    expect(report.fingerprintComponentDiff?.recommendation).toMatch(
      /Original pending fingerprint inputs were not persisted/i,
    );
  });

  it("never prints raw secrets, tokens, signatures, or probe payloads", async () => {
    const report = await buildVercelBridgeDiagnosticReport({ cwd: tempRoot });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("lin_api_test_secret_value");
    expect(serialized).not.toContain("ghp_test_secret_value");
    expect(serialized).not.toContain("vercel_test_secret_value");
    expect(serialized).not.toContain("generated-webhook-secret-value");
    expect(serialized).not.toContain("linear-signature");
    expect(serialized).not.toContain("harness-setup-probe");
  });

  it("reports webhook target drift between stored and canonical production URLs", async () => {
    const report = await buildVercelBridgeDiagnosticReport({ cwd: tempRoot });

    expect(report.webhookTargetDrift?.storedWebhookUrl).toBe(
      "https://harness-gui.vercel.app/api/linear-webhook",
    );
    expect(report.webhookTargetDrift?.canonicalProductionWebhookUrl).toBe(
      "https://harness-gui.vercel.app/api/linear-webhook",
    );
    expect(report.webhookTargetDrift?.latestProductionWebhookUrl).toBe(
      "https://agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app/api/linear-webhook",
    );
    expect(report.webhookTargetDrift?.canonicalSource).toBe("stable_alias");
    expect(report.webhookTargetDrift?.driftDetected).toBe(false);
  });

  it("detects webhook target drift when stored URL is stale", async () => {
    vi.mocked(readControlPlaneSetupState).mockResolvedValue({
      version: 1,
      vercel: {
        teamId: "team-1",
        projectId: "proj-1",
        projectName: "harness-gui",
        productionUrl:
          "https://agentic-product-development-harness-apseun4qi-kinterra-team-url.vercel.app",
        webhookUrl:
          "https://agentic-product-development-harness-apseun4qi-kinterra-team-url.vercel.app/api/linear-webhook",
        endpointReachable: true,
        envVarPresence: {
          LINEAR_WEBHOOK_SECRET: "present",
          GITHUB_DISPATCH_TOKEN: "present",
          HARNESS_TEAM_KEY: "present",
        },
        linearWebhookVerified: true,
        signedProbeVerified: false,
        deploymentRedeployRequired: true,
        appliedFingerprint: "preview-fingerprint",
      },
    });
    vi.mocked(listLinearWebhooks).mockResolvedValue([
      {
        id: "wh-old",
        url: "https://agentic-product-development-harness-apseun4qi-kinterra-team-url.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
        teamId: "linear-team-1",
      },
    ]);

    const report = await buildVercelBridgeDiagnosticReport({ cwd: tempRoot });

    expect(report.webhookTargetDrift?.driftDetected).toBe(true);
    expect(report.webhookTargetDrift?.canonicalProductionWebhookUrl).toBe(
      "https://harness-gui.vercel.app/api/linear-webhook",
    );
    expect(report.webhookTargetDrift?.matchingPreviousLinearWebhookFound).toBe(
      true,
    );
    expect(report.webhookTargetDrift?.canonicalLinearWebhookExists).toBe(false);
    expect(report.webhookTargetDrift?.reconciliationRecommended).toBe(true);
  });

  it("includes deployment and linear webhook metadata", async () => {
    const report = await buildVercelBridgeDiagnosticReport({ cwd: tempRoot });

    expect(report.vercelProductionDeployment?.latestProduction?.id).toBe(
      "dpl-latest",
    );
    expect(report.vercelProductionDeployment?.pendingNewDeployment?.id).toBe(
      "dpl-new-1",
    );
    expect(report.linearWebhookDiagnostic?.matchingWebhookExists).toBe(true);
    expect(report.linearWebhookDiagnostic?.secretReadable).toBe(false);
    expect(report.secretPresence.LINEAR_WEBHOOK_SECRET).toBe(true);
  });

  it("resolves git sha when repository is available", async () => {
    const report = await buildVercelBridgeDiagnosticReport({
      cwd: process.cwd(),
    });

    expect(report.gitSha).toMatch(/^[a-f0-9]{40}$/);
  });
});
