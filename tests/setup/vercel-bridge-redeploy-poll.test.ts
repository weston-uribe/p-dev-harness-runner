import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

vi.mock("../../src/setup/linear-webhook-secret.js", () => ({
  ensureLinearIssueWebhook: vi.fn(),
  generateLinearWebhookSecret: vi.fn(),
  reconcileLinearWebhookUrlForVerification: vi.fn(),
  resolveLinearWebhookCandidateSecret: vi.fn(),
}));

vi.mock("../../src/setup/linear-setup-plan.js", () => ({
  summarizeLinearWebhookReadiness: vi.fn(),
}));

vi.mock("../../src/setup/vercel-setup-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/setup/vercel-setup-client.js")>();
  return {
    ...actual,
    listVercelTeams: vi.fn(),
    listVercelProjects: vi.fn(),
    listVercelProjectEnvVars: vi.fn(),
    summarizeRequiredEnvPresence: vi.fn(),
    upsertVercelProjectEnvVar: vi.fn(),
  };
});

vi.mock("../../src/setup/vercel-webhook-probe.js", () => ({
  runSignedWebhookProbe: vi.fn(),
}));

vi.mock("../../src/setup/control-plane-setup-state.js", () => ({
  updateControlPlaneSetupState: vi.fn(),
  readControlPlaneSetupState: vi.fn(),
}));

vi.mock("../../src/setup/control-plane-state-lock.js", () => {
  let lockQueue = Promise.resolve();
  return {
    withControlPlaneStateLock: vi.fn(
      async (_cwd: string | undefined, fn: () => Promise<unknown>) => {
        const run = lockQueue.then(() => fn());
        lockQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    ),
    acquireControlPlaneStateLock: vi.fn(),
    __resetControlPlaneStateLockQueue: () => {
      lockQueue = Promise.resolve();
    },
  };
});

vi.mock("../../src/setup/vercel-production-redeploy.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/setup/vercel-production-redeploy.js")
    >();
  return {
    ...actual,
    inspectProductionRedeployStatus: vi.fn(),
  };
});

vi.mock("../../src/setup/service-verification.js", () => ({
  loadSecretFromEnvLocal: vi.fn(),
}));

vi.mock("../../src/setup/github-dispatch-token.js", () => ({
  assessGitHubDispatchTokenEligibility: vi.fn(),
}));

import { runSignedWebhookProbe } from "../../src/setup/vercel-webhook-probe.js";
import {
  updateControlPlaneSetupState,
  readControlPlaneSetupState,
} from "../../src/setup/control-plane-setup-state.js";
import { summarizeLinearWebhookReadiness } from "../../src/setup/linear-setup-plan.js";
import {
  ensureLinearIssueWebhook,
  reconcileLinearWebhookUrlForVerification,
  resolveLinearWebhookCandidateSecret,
} from "../../src/setup/linear-webhook-secret.js";
import {
  listVercelProjectEnvVars,
  listVercelProjects,
  listVercelTeams,
  summarizeRequiredEnvPresence,
} from "../../src/setup/vercel-setup-client.js";
import {
  previewVercelBridgeSetup,
  VERCEL_SETUP_ACTIONS,
} from "../../src/setup/vercel-setup-plan.js";
import {
  pollVercelBridgeRedeployVerification,
} from "../../src/setup/vercel-bridge-redeploy-poll.js";
import { inspectProductionRedeployStatus } from "../../src/setup/vercel-production-redeploy.js";
import { loadSecretFromEnvLocal } from "../../src/setup/service-verification.js";
import { assessGitHubDispatchTokenEligibility } from "../../src/setup/github-dispatch-token.js";

const previewResult = {
  actionId: VERCEL_SETUP_ACTIONS.preview.id,
  teams: [],
  projects: [{ id: "proj-1", name: "harness-gui", accountId: "acct-1" }],
  selectedProject: { id: "proj-1", name: "harness-gui", accountId: "acct-1" },
  productionUrl: "https://harness-gui.vercel.app",
  webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
  deploymentStatus: "ready" as const,
  endpointReachable: true,
  envWritePlan: [],
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
} as const;

const pendingVerification = {
  actionId: "vercel-redeploy-test",
  projectId: "proj-1",
  projectName: "harness-gui",
  teamId: "team-1",
  webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
  fingerprint: "preview-fingerprint",
  candidateSecretSource: "generated" as const,
  sourceDeploymentId: "dpl-source-1",
  newDeploymentId: "dpl-new-1",
  status: "triggered" as const,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deadlineAt: new Date(Date.now() + 300_000).toISOString(),
  verifyAttempted: false,
  writtenEnvKeys: ["LINEAR_WEBHOOK_SECRET", "HARNESS_TEAM_KEY"],
  skippedEnvKeys: ["GITHUB_DISPATCH_TOKEN"],
};

const baseVercelState = {
  teamId: "team-1",
  teamName: "Acme",
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
  deploymentRedeployRequired: true,
  appliedFingerprint: "preview-fingerprint",
  redeployVerification: pendingVerification,
};

describe("vercel-bridge-redeploy-poll", () => {
  let tempRoot = "";
  let storedState: {
    version: 1;
    linear?: {
      teamId: string;
      teamKey: string;
      teamName: string;
      teamMode: "existing";
      projectMode: "existing";
      projectName: string;
      statusCoverageComplete: boolean;
    };
    vercel: typeof baseVercelState;
  };

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "vercel-bridge-redeploy-poll-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });

    vi.clearAllMocks();
    const lockModule = await import("../../src/setup/control-plane-state-lock.js");
    (
      lockModule as typeof lockModule & {
        __resetControlPlaneStateLockQueue?: () => void;
      }
    ).__resetControlPlaneStateLockQueue?.();
    storedState = {
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
        ...baseVercelState,
        redeployVerification: { ...pendingVerification },
      },
    };
    vi.mocked(loadSecretFromEnvLocal).mockImplementation(async ({ key }) => {
      if (key === "VERCEL_TOKEN") {
        return "vercel-token";
      }
      if (key === "LINEAR_API_KEY") {
        return "lin_api_test";
      }
      if (key === "GITHUB_TOKEN") {
        return "ghp_saved";
      }
      if (key === "LINEAR_WEBHOOK_SECRET") {
        return "generated-webhook-secret";
      }
      return undefined;
    });
    vi.mocked(assessGitHubDispatchTokenEligibility).mockResolvedValue({
      eligible: true,
      reason: "eligible",
      repoSlug: "weston-uribe/agentic-product-development-harness",
    });
    vi.mocked(readControlPlaneSetupState).mockImplementation(async () => storedState);
    vi.mocked(resolveLinearWebhookCandidateSecret).mockResolvedValue({
      source: "generated",
      manualSteps: [],
    });
    vi.mocked(reconcileLinearWebhookUrlForVerification).mockResolvedValue({
      attempted: true,
      reconciled: true,
      canonicalWebhookExists: false,
      matchingPreviousWebhookFound: true,
      manualSteps: [],
    });
    vi.mocked(ensureLinearIssueWebhook).mockImplementation(async (input) => ({
      mode: "automated",
      secret: input.secret,
      manualSteps: [],
      webhook: {
        id: "wh-1",
        url: "https://harness-gui.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
      },
    }));
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue(previewResult);
    vi.mocked(listVercelTeams).mockResolvedValue([
      { id: "team-1", name: "Acme", slug: "acme" },
    ]);
    vi.mocked(listVercelProjects).mockResolvedValue([
      { id: "proj-1", name: "harness-gui", accountId: "acct-1" },
    ]);
    vi.mocked(listVercelProjectEnvVars).mockResolvedValue([
      { id: "env-1", key: "LINEAR_WEBHOOK_SECRET", type: "sensitive" },
      { id: "env-2", key: "GITHUB_DISPATCH_TOKEN", type: "sensitive" },
      { id: "env-3", key: "HARNESS_TEAM_KEY", type: "plain" },
    ]);
    vi.mocked(summarizeRequiredEnvPresence).mockReturnValue({
      LINEAR_WEBHOOK_SECRET: "present",
      GITHUB_DISPATCH_TOKEN: "present",
      HARNESS_TEAM_KEY: "present",
    });
    vi.mocked(summarizeLinearWebhookReadiness).mockResolvedValue({
      matchingWebhook: {
        id: "wh-1",
        url: "https://harness-gui.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
      },
      manualSteps: [],
    });
    vi.mocked(updateControlPlaneSetupState).mockImplementation(async (patch) => {
      storedState = {
        version: 1,
        vercel: {
          ...storedState.vercel,
          ...patch.vercel,
        },
      };
      return storedState;
    });
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "building",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Waiting for Vercel deployment READY…",
    });
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: true,
      result: "accepted_ignored",
      reason: "ignored_event",
      probedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("returns building state while deployment is not READY", async () => {
    const result = await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    expect(result.setupPending).toBe(true);
    expect(result.productionRedeployStatus).toBe("building");
    expect(result.verified).toBe(false);
    expect(result.writtenEnvKeys).toEqual([
      "LINEAR_WEBHOOK_SECRET",
      "HARNESS_TEAM_KEY",
    ]);
    expect(result.writtenEnvKeys.join(", ")).not.toBe("none");
    expect(ensureLinearIssueWebhook).not.toHaveBeenCalled();
  });

  it("succeeds with only actionId and no client plan payload", async () => {
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "ready",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Production redeploy completed and deployment is READY.",
    });

    const result = await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    expect(result.verified).toBe(true);
    expect(result.setupPending).toBe(false);
  });

  it("reconstructs verify plan from persisted state with linear team and github dispatch context", async () => {
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "ready",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Production redeploy completed and deployment is READY.",
    });

    await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    expect(previewVercelBridgeSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        projectId: "proj-1",
        projectName: "harness-gui",
        preferredProductionDeploymentId: "dpl-new-1",
        linearTeamId: "linear-team-1",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
        willGenerateLinearWebhookSecret: true,
        verificationLinearWebhookSecret: "generated-webhook-secret",
        preserveGeneratedWebhookSecretFingerprint: true,
      }),
    );
    expect(ensureLinearIssueWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        mutatePolicy: "verify-only",
        linearTeamId: "linear-team-1",
      }),
    );
  });

  it("returns setupBlocked when persisted fingerprint no longer matches reconstructed plan", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue({
      ...previewResult,
      fingerprint: "different-fingerprint",
    });

    const result = await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    expect(result.setupBlocked?.message).toMatch(
      /Persisted Step 3 setup context no longer matches/i,
    );
    expect(result.setupPending).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Preview fingerprint is stale");
    expect(ensureLinearIssueWebhook).not.toHaveBeenCalled();

    const logOutput = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logOutput).toMatch(/\[setup:vercel-bridge\]/);
    expect(logOutput).toContain("different-fingerprint");
    expect(logOutput).not.toContain("generated-webhook-secret");
    logSpy.mockRestore();
  });

  it("automatically runs verifyOnly after READY without requiring manual retry", async () => {
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "ready",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Production redeploy completed and deployment is READY.",
    });

    const result = await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    expect(ensureLinearIssueWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        mutatePolicy: "verify-only",
        secret: "generated-webhook-secret",
      }),
    );
    expect(result.verified).toBe(true);
    expect(result.signedProbeVerified).toBe(true);
    expect(result.setupPending).toBe(false);
    expect(updateControlPlaneSetupState).toHaveBeenCalledWith(
      expect.objectContaining({
        vercel: expect.objectContaining({
          signedProbeVerified: true,
          deploymentRedeployRequired: false,
          redeployVerification: undefined,
        }),
      }),
      tempRoot,
    );
  });

  it("uses saved generated webhook secret for poll verify without changing preview fingerprint semantics", async () => {
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "ready",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Production redeploy completed and deployment is READY.",
    });

    await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    const previewPlan = vi.mocked(previewVercelBridgeSetup).mock.calls.at(-1)?.[0];
    expect(previewPlan?.envInput?.LINEAR_WEBHOOK_SECRET).toBeUndefined();
    expect(previewPlan?.willGenerateLinearWebhookSecret).toBe(true);
    expect(previewPlan?.preserveGeneratedWebhookSecretFingerprint).toBe(true);
    expect(previewPlan?.verificationLinearWebhookSecret).toBe(
      "generated-webhook-secret",
    );
  });

  it("returns setupBlocked when post-redeploy verifyOnly retry fails terminally", async () => {
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "ready",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Production redeploy completed and deployment is READY.",
    });
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "protection_redirect",
      reason: "vercel_protection",
      probedAt: new Date().toISOString(),
    });

    const result = await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    expect(result.setupBlocked?.message).toMatch(
      /signed webhook delivery verification still failed/i,
    );
    expect(result.setupPending).toBe(false);
    expect(result.verified).toBe(false);
  });

  it("schedules another verify attempt after a retryable failure", async () => {
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "ready",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Production redeploy completed and deployment is READY.",
    });
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      probedAt: new Date().toISOString(),
    });

    const result = await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    expect(result.setupPending).toBe(true);
    expect(result.orchestrationPhase).toBe("retry_wait");
    expect(result.verificationAttemptCount).toBe(1);
  });

  it("returns timeout setupBlocked and keeps retry visible", async () => {
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "timeout",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message:
        "Production redeploy did not reach READY before the timeout. Retry verification after Vercel finishes building.",
    });

    const result = await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    expect(result.productionRedeployStatus).toBe("timeout");
    expect(result.setupBlocked?.message).toMatch(/timeout/i);
    expect(result.setupPending).toBe(false);
  });

  it("does not run verifyOnly twice when polling races after READY", async () => {
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "ready",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Production redeploy completed and deployment is READY.",
    });

    await Promise.all([
      pollVercelBridgeRedeployVerification({
        actionId: "vercel-redeploy-test",
        cwd: tempRoot,
      }),
      pollVercelBridgeRedeployVerification({
        actionId: "vercel-redeploy-test",
        cwd: tempRoot,
      }),
    ]);

    expect(ensureLinearIssueWebhook).toHaveBeenCalledTimes(1);
  });

  it("reconciles stale stored webhook URL after READY using canonical production target", async () => {
    storedState.vercel = {
      ...baseVercelState,
      productionUrl:
        "https://agentic-product-development-harness-apseun4qi-kinterra-team-url.vercel.app",
      webhookUrl:
        "https://agentic-product-development-harness-apseun4qi-kinterra-team-url.vercel.app/api/linear-webhook",
      redeployVerification: { ...pendingVerification },
    };
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue({
      ...previewResult,
      productionUrl: "https://harness-gui.vercel.app",
      webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
      productionUrlSource: "stable_alias",
      canonicalDeploymentId: "dpl-new-1",
    });
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "ready",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Production redeploy completed and deployment is READY.",
    });

    const result = await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    expect(ensureLinearIssueWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
        mutatePolicy: "verify-only",
      }),
    );
    expect(reconcileLinearWebhookUrlForVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        previousWebhookUrl:
          "https://agentic-product-development-harness-apseun4qi-kinterra-team-url.vercel.app/api/linear-webhook",
        canonicalWebhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
        secret: "generated-webhook-secret",
      }),
    );
    expect(runSignedWebhookProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
      }),
    );
    expect(storedState.vercel.productionUrl).toBe("https://harness-gui.vercel.app");
    expect(storedState.vercel.webhookUrl).toBe(
      "https://harness-gui.vercel.app/api/linear-webhook",
    );
    expect(result.verified).toBe(true);
    expect(JSON.stringify(result)).not.toContain("generated-webhook-secret");
  });

  it("buildPollVerifyPlanFromPersistedState never exposes secret values in poll results", async () => {
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "building",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Waiting for Vercel deployment READY…",
    });

    const result = await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ghp_saved");
    expect(serialized).not.toContain("lin_api_test");
    expect(serialized).not.toContain("vercel-token");
    expect(serialized).not.toContain("stable-webhook-secret");
    expect(serialized).not.toContain("generated-webhook-secret");
  });

  it("terminalizes when verification deadline expires while deployment is READY", async () => {
    storedState.vercel.redeployVerification = {
      ...pendingVerification,
      status: "ready",
      deadlineAt: new Date(Date.now() - 1_000).toISOString(),
    };
    vi.mocked(inspectProductionRedeployStatus).mockResolvedValue({
      status: "ready",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Production redeploy completed and deployment is READY.",
    });

    const result = await pollVercelBridgeRedeployVerification({
      actionId: "vercel-redeploy-test",
      cwd: tempRoot,
    });

    expect(result.setupBlocked?.message).toMatch(/timed out|Redeploy production/i);
    expect(result.setupPending).toBe(false);
    expect(result.verified).toBe(false);
    expect(ensureLinearIssueWebhook).not.toHaveBeenCalled();
  });
});
