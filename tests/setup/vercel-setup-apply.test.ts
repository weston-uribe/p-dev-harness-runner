import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    createVercelTeam: vi.fn(),
    createVercelProject: vi.fn(),
    checkWebhookEndpointReachable: vi.fn(),
    listVercelProjectEnvVars: vi.fn(),
    summarizeRequiredEnvPresence: vi.fn(),
    resolveCanonicalProductionTarget: vi.fn(),
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

vi.mock("../../src/setup/vercel-production-redeploy.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/setup/vercel-production-redeploy.js")
    >();
  return {
    ...actual,
    findLatestReadyProductionDeploymentId: vi.fn(),
    triggerProductionRedeployOnce: vi.fn(),
  };
});

vi.mock("../../src/setup/github-dispatch-token.js", () => ({
  assessGitHubDispatchTokenEligibility: vi.fn(),
}));

vi.mock("../../src/setup/service-verification.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/setup/service-verification.js")>();
  return {
    ...actual,
    loadSecretFromEnvLocal: vi.fn(),
  };
});

vi.mock("../../src/setup/vercel-bridge-deploy.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/setup/vercel-bridge-deploy.js")>();
  return {
    ...actual,
    resolvePreferredVercelBridgeSource: vi.fn(),
    deployVercelBridgeProduction: vi.fn(),
  };
});

import { runSignedWebhookProbe } from "../../src/setup/vercel-webhook-probe.js";
import {
  updateControlPlaneSetupState,
  readControlPlaneSetupState,
} from "../../src/setup/control-plane-setup-state.js";
import { summarizeLinearWebhookReadiness } from "../../src/setup/linear-setup-plan.js";
import {
  ensureLinearIssueWebhook,
  generateLinearWebhookSecret,
  reconcileLinearWebhookUrlForVerification,
  resolveLinearWebhookCandidateSecret,
} from "../../src/setup/linear-webhook-secret.js";
import {
  createVercelProject,
  checkWebhookEndpointReachable,
  listVercelProjectEnvVars,
  listVercelProjects,
  listVercelTeams,
  resolveCanonicalProductionTarget,
  summarizeRequiredEnvPresence,
  upsertVercelProjectEnvVar,
} from "../../src/setup/vercel-setup-client.js";
import {
  previewVercelBridgeSetup,
  VERCEL_SETUP_ACTIONS,
} from "../../src/setup/vercel-setup-plan.js";
import { applyVercelBridgeSetup } from "../../src/setup/vercel-setup-apply.js";
import * as linearWebhookEnvLocal from "../../src/setup/linear-webhook-env-local.js";
import { resolveLocalFilePaths } from "../../src/setup/setup-state.js";
import { parseEnvFileContent } from "../../src/setup/env-merge.js";
import {
  findLatestReadyProductionDeploymentId,
  triggerProductionRedeployOnce,
} from "../../src/setup/vercel-production-redeploy.js";
import { assessGitHubDispatchTokenEligibility } from "../../src/setup/github-dispatch-token.js";
import { loadSecretFromEnvLocal } from "../../src/setup/service-verification.js";
import {
  deployVercelBridgeProduction,
  resolvePreferredVercelBridgeSource,
} from "../../src/setup/vercel-bridge-deploy.js";

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
    {
      key: "LINEAR_WEBHOOK_SECRET",
      action: "create",
      source: "generated",
    },
    {
      key: "GITHUB_DISPATCH_TOKEN",
      action: "update",
      source: "derived",
      existingType: "sensitive",
      desiredType: "sensitive",
    },
    {
      key: "HARNESS_TEAM_KEY",
      action: "create",
      source: "derived",
    },
  ],
  requiredEnvPresence: {
    LINEAR_WEBHOOK_SECRET: "missing",
    GITHUB_DISPATCH_TOKEN: "missing",
    HARNESS_TEAM_KEY: "missing",
  },
  linearWebhookVerified: false,
  readiness: {
    ready: false,
    blockers: [],
    warnings: [],
  },
  manualSteps: [],
  fingerprint: "preview-fingerprint",
  permission: VERCEL_SETUP_ACTIONS.preview.permission,
} as const;

describe("vercel-setup-apply", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "vercel-setup-apply-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });

    vi.clearAllMocks();
    vi.mocked(readControlPlaneSetupState).mockResolvedValue(null);
    vi.mocked(loadSecretFromEnvLocal).mockImplementation(async ({ key }) => {
      if (key === "GITHUB_TOKEN") {
        return "ghp_saved";
      }
      return undefined;
    });
    vi.mocked(assessGitHubDispatchTokenEligibility).mockResolvedValue({
      eligible: true,
      source: "saved-github-token",
      repository: "owner/harness",
      message: "Saved GITHUB_TOKEN can dispatch to owner/harness.",
    });
    vi.mocked(resolveLinearWebhookCandidateSecret).mockResolvedValue({
      secret: "generated-webhook-secret",
      source: "generated",
      manualSteps: [],
    });
    vi.mocked(generateLinearWebhookSecret).mockReturnValue("generated-webhook-secret");
    vi.mocked(reconcileLinearWebhookUrlForVerification).mockResolvedValue({
      attempted: false,
      reconciled: false,
      canonicalWebhookExists: false,
      matchingPreviousWebhookFound: false,
      manualSteps: [],
    });
    vi.mocked(ensureLinearIssueWebhook).mockResolvedValue({
      mode: "automated",
      secret: "generated-webhook-secret",
      manualSteps: [],
      webhook: {
        id: "wh-1",
        url: "https://harness-gui.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
      },
    });
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue(previewResult);
    vi.mocked(listVercelTeams).mockResolvedValue([
      { id: "team-1", name: "Acme", slug: "acme" },
    ]);
    vi.mocked(listVercelProjects).mockResolvedValue([
      { id: "proj-1", name: "harness-gui", accountId: "acct-1" },
    ]);
    vi.mocked(createVercelProject).mockResolvedValue({
      id: "proj-created",
      name: "new-harness-gui",
      accountId: "acct-1",
    });
    vi.mocked(resolvePreferredVercelBridgeSource).mockResolvedValue({
      source: "artifact",
      reason: "github_namespace_not_available_to_vercel",
    });
    vi.mocked(deployVercelBridgeProduction).mockResolvedValue({
      status: "ready",
      source: "artifact",
      deploymentId: "dpl-created",
      deploymentUrl: "new-harness-gui.vercel.app",
      message: "Vercel bridge artifact deployment reached READY.",
    });
    vi.mocked(resolveCanonicalProductionTarget).mockResolvedValue({
      productionUrl: "https://new-harness-gui.vercel.app",
      webhookUrl: "https://new-harness-gui.vercel.app/api/linear-webhook",
      deploymentId: "dpl-created",
      deploymentUrl: "new-harness-gui.vercel.app",
      source: "stable_alias",
      stableAlias: "new-harness-gui.vercel.app",
      readyState: "READY",
      state: "READY",
    });
    vi.mocked(checkWebhookEndpointReachable).mockResolvedValue({
      reachable: true,
      statusCode: 405,
    });
    vi.mocked(listVercelProjectEnvVars).mockResolvedValue([
      {
        id: "env-sensitive",
        key: "GITHUB_DISPATCH_TOKEN",
        type: "sensitive",
        target: ["production"],
      },
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
    vi.mocked(updateControlPlaneSetupState).mockResolvedValue(undefined);
    vi.mocked(upsertVercelProjectEnvVar).mockResolvedValue(undefined);
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: true,
      result: "accepted_ignored",
      reason: "ignored_event",
      probedAt: new Date().toISOString(),
      webhookHost: "harness-gui.vercel.app",
      webhookPath: "/api/linear-webhook",
    });
    vi.mocked(findLatestReadyProductionDeploymentId).mockResolvedValue(
      "dpl-source-1",
    );
    vi.mocked(triggerProductionRedeployOnce).mockResolvedValue({
      status: "triggered",
      sourceDeploymentId: "dpl-source-1",
      newDeploymentId: "dpl-new-1",
      message: "Production redeploy triggered. Waiting for Vercel deployment READY.",
    });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("requires confirmation before writing Vercel bridge env vars", async () => {
    await expect(
      applyVercelBridgeSetup({
        plan: {
          vercelToken: "vercel-token",
          projectId: "proj-1",
          linearApiKey: "lin_api_test",
          derivedHarnessTeamKey: "WES",
          derivedGithubDispatchToken: "ghp_saved",
        },
        confirmed: false,
        fingerprint: "preview-fingerprint",
        cwd: tempRoot,
      }),
    ).rejects.toThrow(/confirmation/i);
  });

  it("writes env vars after confirmation and preserves existing env var metadata", async () => {
    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(previewVercelBridgeSetup).toHaveBeenCalledTimes(2);
    expect(ensureLinearIssueWebhook).toHaveBeenCalled();
    expect(upsertVercelProjectEnvVar).toHaveBeenCalledWith(
      "vercel-token",
      expect.objectContaining({
        key: "GITHUB_DISPATCH_TOKEN",
        existingEnv: expect.objectContaining({ type: "sensitive" }),
      }),
    );
    expect(listVercelProjectEnvVars).toHaveBeenCalledTimes(2);
    expect(updateControlPlaneSetupState).toHaveBeenCalledWith(
      expect.objectContaining({
        vercel: expect.objectContaining({
          envVarPresence: {
            LINEAR_WEBHOOK_SECRET: "present",
            GITHUB_DISPATCH_TOKEN: "present",
            HARNESS_TEAM_KEY: "present",
          },
        }),
      }),
      tempRoot,
    );
    expect(result.verified).toBe(true);
    expect(result.signedProbeVerified).toBe(true);
    expect(result.status).toBe("applied");
    expect(result.project?.outcome).toBe("reused");
    expect(result.writtenEnvKeys).toEqual([
      "LINEAR_WEBHOOK_SECRET",
      "GITHUB_DISPATCH_TOKEN",
      "HARNESS_TEAM_KEY",
    ]);
    expect(JSON.stringify(result)).not.toContain("generated-webhook-secret");
    expect(JSON.stringify(result)).not.toContain("ghp_saved");
  });

  it("exposes manual-copy secret only in apply result fallback state", async () => {
    vi.mocked(ensureLinearIssueWebhook).mockResolvedValue({
      mode: "manual-copy",
      secret: "manual-copy-secret",
      manualSteps: ["Copy the generated secret into Linear."],
    });
    vi.mocked(summarizeLinearWebhookReadiness).mockResolvedValue({
      matchingWebhook: undefined,
      manualSteps: [],
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(result.linearWebhookSetup.mode).toBe("manual-copy");
    expect(result.linearWebhookSetup.manualCopySecret).toBe("manual-copy-secret");
    expect(result.verified).toBe(false);
    expect(result.signedProbeVerified).toBe(true);
    expect(result.status).toBe("applied");
  });

  it("blocks unmanaged existing projects without env or Linear writes when no production URL exists", async () => {
    vi.mocked(previewVercelBridgeSetup)
      .mockResolvedValueOnce(previewResult)
      .mockResolvedValueOnce({
        ...previewResult,
        webhookUrl: undefined,
        productionUrl: undefined,
        deploymentStatus: "missing",
        deploymentRequired: {
          message:
            'Project "harness-gui" exists in Vercel but has no production deployment yet.',
          nextSteps: ["Deploy the project in Vercel before applying settings."],
        },
      });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(result.status).toBe("applied");
    expect(result.setupBlocked?.message).toMatch(/will not install/i);
    expect(ensureLinearIssueWebhook).not.toHaveBeenCalled();
    expect(upsertVercelProjectEnvVar).not.toHaveBeenCalled();
    expect(updateControlPlaneSetupState).not.toHaveBeenCalled();
    expect(result.verified).toBe(false);
    expect(result.signedProbeVerified).toBe(false);
  });

  it("allows explicit bridge install confirmation for an existing project without deployment", async () => {
    vi.mocked(previewVercelBridgeSetup)
      .mockResolvedValueOnce(previewResult)
      .mockResolvedValueOnce({
        ...previewResult,
        webhookUrl: undefined,
        productionUrl: undefined,
        deploymentStatus: "missing",
        deploymentRequired: {
          message:
            'Project "harness-gui" exists in Vercel but has no production deployment yet.',
          nextSteps: ["Deploy the project in Vercel before applying settings."],
        },
      });
    vi.mocked(listVercelProjectEnvVars).mockResolvedValueOnce([]);

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
        allowExistingProjectBridgeInstall: true,
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(result.status).toBe("applied");
    expect(result.setupBlocked).toBeUndefined();
    expect(upsertVercelProjectEnvVar).toHaveBeenCalledWith(
      "vercel-token",
      expect.objectContaining({ key: "PDEV_BRIDGE_PROJECT_MARKER" }),
    );
    expect(deployVercelBridgeProduction).toHaveBeenCalled();
    expect(result.signedProbeVerified).toBe(true);
  });

  it("allows existing projects with the PDev marker without explicit confirmation", async () => {
    vi.mocked(previewVercelBridgeSetup)
      .mockResolvedValueOnce(previewResult)
      .mockResolvedValueOnce({
        ...previewResult,
        webhookUrl: undefined,
        productionUrl: undefined,
        deploymentStatus: "missing",
      });
    vi.mocked(listVercelProjectEnvVars).mockResolvedValueOnce([
      {
        id: "env-marker",
        key: "PDEV_BRIDGE_PROJECT_MARKER",
        type: "plain",
        target: ["production"],
      },
    ]);

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(result.setupBlocked).toBeUndefined();
    expect(deployVercelBridgeProduction).toHaveBeenCalled();
    expect(upsertVercelProjectEnvVar).not.toHaveBeenCalledWith(
      "vercel-token",
      expect.objectContaining({ key: "PDEV_BRIDGE_PROJECT_MARKER" }),
    );
  });

  it("creates a new project from actionable preview and does not complete on failed probe", async () => {
    vi.mocked(previewVercelBridgeSetup)
      .mockResolvedValueOnce({
        ...previewResult,
        selectedProject: undefined,
        productionUrl: undefined,
        webhookUrl: undefined,
        deploymentStatus: "project-will-be-created",
        endpointReachable: false,
        fingerprint: "create-preview-fingerprint",
        validationError: undefined,
        manualSteps: [
          'Project "new-harness-gui" will be created during apply if it does not already exist.',
        ],
      })
      .mockResolvedValueOnce({
        ...previewResult,
        projects: [
          { id: "proj-created", name: "new-harness-gui", accountId: "acct-1" },
        ],
        selectedProject: {
          id: "proj-created",
          name: "new-harness-gui",
          accountId: "acct-1",
        },
        productionUrl: undefined,
        webhookUrl: undefined,
        deploymentStatus: "missing",
        endpointReachable: false,
        fingerprint: "created-project-fingerprint",
      });
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      probedAt: new Date().toISOString(),
      webhookHost: "harness-gui.vercel.app",
      webhookPath: "/api/linear-webhook",
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        team: { mode: "existing", teamId: "" },
        project: { mode: "create", projectName: "new-harness-gui" },
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
        derivedGithubDispatchRepository: "owner/harness",
        willGenerateLinearWebhookSecret: true,
      },
      confirmed: true,
      fingerprint: "create-preview-fingerprint",
      cwd: tempRoot,
    });

    expect(createVercelProject).toHaveBeenCalledWith("vercel-token", {
      name: "new-harness-gui",
      teamId: undefined,
      gitRepository: undefined,
    });
    expect(upsertVercelProjectEnvVar).toHaveBeenCalled();
    expect(upsertVercelProjectEnvVar).toHaveBeenCalledWith(
      "vercel-token",
      expect.objectContaining({
        projectId: "proj-created",
        key: "PDEV_BRIDGE_PROJECT_MARKER",
        value: "p-dev-managed",
      }),
    );
    expect(
      vi.mocked(upsertVercelProjectEnvVar).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(deployVercelBridgeProduction).mock.invocationCallOrder[0]!,
    );
    expect(deployVercelBridgeProduction).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "new-harness-gui",
        preferredSource: "artifact",
      }),
    );
    expect(result.status).toBe("applied");
    expect(result.project?.outcome).toBe("created");
    expect(result.signedProbeVerified).toBe(false);
    expect(result.verified).toBe(false);
    expect(updateControlPlaneSetupState).toHaveBeenCalledWith(
      expect.objectContaining({
        vercel: expect.objectContaining({
          projectId: "proj-created",
          signedProbeVerified: false,
        }),
      }),
      tempRoot,
    );
  });

  it("does not mark existing-unverified webhook setup as verified", async () => {
    vi.mocked(ensureLinearIssueWebhook).mockResolvedValue({
      mode: "existing-unverified",
      secret: "generated-webhook-secret",
      manualSteps: ["Rotate the Linear webhook signing secret."],
      webhook: {
        id: "wh-1",
        url: "https://harness-gui.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
      },
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

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(result.linearWebhookSetup.mode).toBe("existing-unverified");
    expect(result.verified).toBe(false);
    expect(result.signedProbeVerified).toBe(true);
  });

  it("updates existing Vercel LINEAR_WEBHOOK_SECRET and fails probe when stale value is preserved", async () => {
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue({
      ...previewResult,
      envWritePlan: [
        {
          key: "LINEAR_WEBHOOK_SECRET",
          action: "skip",
          source: "preserve-existing",
        },
        {
          key: "GITHUB_DISPATCH_TOKEN",
          action: "update",
          source: "derived",
        },
        {
          key: "HARNESS_TEAM_KEY",
          action: "create",
          source: "derived",
        },
      ],
    });
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      probedAt: new Date().toISOString(),
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(upsertVercelProjectEnvVar).toHaveBeenCalledWith(
      "vercel-token",
      expect.objectContaining({
        key: "LINEAR_WEBHOOK_SECRET",
        value: "generated-webhook-secret",
      }),
    );
    expect(result.signedProbeVerified).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.productionRedeployTriggered).toBe(true);
    expect(triggerProductionRedeployOnce).toHaveBeenCalledTimes(1);
    expect(result.setupPending).toBe(true);
    expect(result.pollActionId).toBeTruthy();
    expect(result.productionRedeployStatus).toBe("triggered");
  });

  it("does not allow manualComplete to override a failed signed probe", async () => {
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      probedAt: new Date().toISOString(),
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      manualComplete: true,
      cwd: tempRoot,
    });

    expect(result.verified).toBe(false);
    expect(result.signedProbeVerified).toBe(false);
  });

  it("returns pending redeploy state quickly when stale signature probe requires auto-redeploy", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      probedAt: new Date().toISOString(),
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(result.writtenEnvKeys).toContain("LINEAR_WEBHOOK_SECRET");
    expect(triggerProductionRedeployOnce).toHaveBeenCalledTimes(1);
    expect(result.productionRedeployTriggered).toBe(true);
    expect(result.productionRedeployStatus).toBe("triggered");
    expect(result.setupPending).toBe(true);
    expect(result.pollActionId).toMatch(/^vercel-redeploy-/);
    expect(result.signedProbeVerified).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.candidateSecretSource).toBe("generated");
    expect(result.signedProbeInitialResult?.reason).toBe("invalid_signature");
    expect(result.setupBlocked).toBeUndefined();
    expect(updateControlPlaneSetupState).toHaveBeenCalledWith(
      expect.objectContaining({
        vercel: expect.objectContaining({
          redeployVerification: expect.objectContaining({
            newDeploymentId: "dpl-new-1",
            sourceDeploymentId: "dpl-source-1",
            verifyAttempted: false,
            fingerprint: "preview-fingerprint",
            fingerprintInputs: expect.objectContaining({
              projectId: "proj-1",
              linearWebhookSecretToken: "generate-on-apply",
            }),
            candidateSecretSource: "generated",
          }),
        }),
      }),
      tempRoot,
    );
    const envContent = await readFile(
      resolveLocalFilePaths(tempRoot).envLocal,
      "utf8",
    );
    expect(parseEnvFileContent(envContent).values.LINEAR_WEBHOOK_SECRET).toBe(
      "generated-webhook-secret",
    );
    const persistedState = vi.mocked(updateControlPlaneSetupState).mock.calls.at(
      -1,
    )?.[0];
    expect(JSON.stringify(persistedState)).not.toContain("generated-webhook-secret");
    expect(JSON.stringify(result)).not.toContain("generated-webhook-secret");
    expect(JSON.stringify(result)).not.toContain("ghp_saved");

    const logOutput = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logOutput).toMatch(/\[setup:vercel-bridge\]/);
    expect(logOutput).not.toContain("generated-webhook-secret");
    expect(logOutput).not.toContain("ghp_saved");
    expect(logOutput).not.toContain("lin_api_test");
    logSpy.mockRestore();
  });

  it("uses saved .env.local webhook secret on generated verifyOnly retry without manual-copy", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    await writeFile(
      paths.envLocal,
      `LINEAR_WEBHOOK_SECRET=generated-webhook-secret\n`,
      "utf8",
    );
    vi.mocked(readControlPlaneSetupState).mockResolvedValue({
      version: 1,
      vercel: {
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
        redeployVerification: {
          actionId: "vercel-redeploy-existing",
          projectId: "proj-1",
          projectName: "harness-gui",
          webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
          fingerprint: "preview-fingerprint",
          candidateSecretSource: "generated",
          sourceDeploymentId: "dpl-source-1",
          newDeploymentId: "dpl-new-1",
          status: "verify_failed",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deadlineAt: new Date(Date.now() + 300_000).toISOString(),
          verifyAttempted: true,
        },
      },
    });
    vi.mocked(resolveLinearWebhookCandidateSecret).mockResolvedValue({
      source: "generated",
      manualSteps: [],
    });
    vi.mocked(generateLinearWebhookSecret).mockReturnValue("new-rotated-secret");
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: true,
      result: "accepted_ignored",
      reason: "ignored_event",
      probedAt: new Date().toISOString(),
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
        willGenerateLinearWebhookSecret: true,
        verificationLinearWebhookSecret: "generated-webhook-secret",
        preserveGeneratedWebhookSecretFingerprint: true,
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      verifyOnly: true,
      cwd: tempRoot,
    });

    expect(generateLinearWebhookSecret).not.toHaveBeenCalled();
    expect(ensureLinearIssueWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: "generated-webhook-secret",
        mutatePolicy: "verify-only",
      }),
    );
    expect(result.linearWebhookSetup.mode).not.toBe("manual-copy");
    expect(result.linearWebhookSetup.manualCopySecret).toBeUndefined();
    expect(result.signedProbeVerified).toBe(true);
  });

  it("upserts reused-readable LINEAR_WEBHOOK_SECRET even when Vercel already has the env var", async () => {
    vi.mocked(resolveLinearWebhookCandidateSecret).mockResolvedValue({
      secret: "stable-webhook-secret",
      source: "reused-readable",
      manualSteps: [],
    });
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue({
      ...previewResult,
      envWritePlan: [
        {
          key: "LINEAR_WEBHOOK_SECRET",
          action: "skip",
          source: "preserve-existing",
        },
        {
          key: "GITHUB_DISPATCH_TOKEN",
          action: "update",
          source: "derived",
        },
        {
          key: "HARNESS_TEAM_KEY",
          action: "create",
          source: "derived",
        },
      ],
    });
    vi.mocked(listVercelProjectEnvVars).mockReset();
    vi.mocked(listVercelProjectEnvVars).mockResolvedValue([
      { id: "env-1", key: "LINEAR_WEBHOOK_SECRET", type: "sensitive" },
      { id: "env-2", key: "GITHUB_DISPATCH_TOKEN", type: "sensitive" },
      { id: "env-3", key: "HARNESS_TEAM_KEY", type: "plain" },
    ]);
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      probedAt: new Date().toISOString(),
    });
    vi.mocked(ensureLinearIssueWebhook).mockResolvedValue({
      mode: "automated",
      secret: "stable-webhook-secret",
      manualSteps: [],
      webhook: {
        id: "wh-1",
        url: "https://harness-gui.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
      },
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(upsertVercelProjectEnvVar).toHaveBeenCalledWith(
      "vercel-token",
      expect.objectContaining({
        key: "LINEAR_WEBHOOK_SECRET",
        value: "stable-webhook-secret",
      }),
    );
    expect(result.writtenEnvKeys).toContain("LINEAR_WEBHOOK_SECRET");
    expect(result.candidateSecretSource).toBe("reused-readable");
    expect(result.signedProbeVerified).toBe(false);
    expect(result.productionRedeployTriggered).toBe(true);
    expect(JSON.stringify(result)).not.toContain("stable-webhook-secret");
  });

  it("reuses the same webhook secret on verification retry without rewriting Vercel or rotating Linear", async () => {
    vi.mocked(readControlPlaneSetupState).mockResolvedValue({
      version: 1,
      vercel: {
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
      },
    });
    vi.mocked(resolveLinearWebhookCandidateSecret).mockResolvedValue({
      secret: "stable-webhook-secret",
      source: "reused-readable",
      manualSteps: [],
    });
    vi.mocked(listVercelProjectEnvVars).mockResolvedValue([
      { id: "env-1", key: "LINEAR_WEBHOOK_SECRET", type: "sensitive" },
      { id: "env-2", key: "GITHUB_DISPATCH_TOKEN", type: "sensitive" },
      { id: "env-3", key: "HARNESS_TEAM_KEY", type: "plain" },
    ]);
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: true,
      result: "accepted_ignored",
      reason: "ignored_event",
      probedAt: new Date().toISOString(),
      webhookHost: "harness-gui.vercel.app",
      webhookPath: "/api/linear-webhook",
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      verifyOnly: true,
      cwd: tempRoot,
    });

    expect(generateLinearWebhookSecret).not.toHaveBeenCalled();
    expect(ensureLinearIssueWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: "stable-webhook-secret",
        mutatePolicy: "verify-only",
      }),
    );
    expect(upsertVercelProjectEnvVar).not.toHaveBeenCalledWith(
      "vercel-token",
      expect.objectContaining({ key: "LINEAR_WEBHOOK_SECRET" }),
    );
    expect(result.writtenEnvKeys).not.toContain("LINEAR_WEBHOOK_SECRET");
    expect(result.verificationRetry).toBe(true);
    expect(result.candidateSecretSource).toBe("reused-readable");
    expect(result.deploymentRedeployRequired).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.signedProbeVerified).toBe(true);
  });

  it("reconciles stale deployment-specific URLs on verification retry without secret rotation", async () => {
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue({
      ...previewResult,
      productionUrl: "https://harness-gui.vercel.app",
      webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
      productionUrlSource: "stable_alias",
      canonicalDeploymentId: "dpl-new-1",
    });
    vi.mocked(reconcileLinearWebhookUrlForVerification).mockResolvedValue({
      attempted: true,
      reconciled: true,
      previousWebhookId: "wh-1",
      previousWebhookUrl:
        "https://agentic-product-development-harness-apseun4qi-kinterra-team-url.vercel.app/api/linear-webhook",
      canonicalWebhookExists: false,
      matchingPreviousWebhookFound: true,
      manualSteps: [],
    });
    vi.mocked(readControlPlaneSetupState).mockResolvedValue({
      version: 1,
      vercel: {
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
        deploymentRedeployRequired: true,
        appliedFingerprint: "preview-fingerprint",
      },
    });
    vi.mocked(resolveLinearWebhookCandidateSecret).mockResolvedValue({
      secret: "stable-webhook-secret",
      source: "generated",
      manualSteps: [],
    });
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: true,
      result: "accepted_ignored",
      reason: "ignored_event",
      probedAt: new Date().toISOString(),
      webhookHost: "harness-gui.vercel.app",
      webhookPath: "/api/linear-webhook",
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
        verificationLinearWebhookSecret: "stable-webhook-secret",
        preserveGeneratedWebhookSecretFingerprint: true,
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      verifyOnly: true,
      cwd: tempRoot,
    });

    expect(reconcileLinearWebhookUrlForVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        previousWebhookUrl:
          "https://agentic-product-development-harness-apseun4qi-kinterra-team-url.vercel.app/api/linear-webhook",
        canonicalWebhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
        secret: "stable-webhook-secret",
      }),
    );
    expect(ensureLinearIssueWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
        mutatePolicy: "verify-only",
      }),
    );
    expect(runSignedWebhookProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
      }),
    );
    expect(upsertVercelProjectEnvVar).not.toHaveBeenCalledWith(
      "vercel-token",
      expect.objectContaining({ key: "LINEAR_WEBHOOK_SECRET" }),
    );
    expect(generateLinearWebhookSecret).not.toHaveBeenCalled();
    expect(updateControlPlaneSetupState).toHaveBeenCalledWith(
      expect.objectContaining({
        vercel: expect.objectContaining({
          productionUrl: "https://harness-gui.vercel.app",
          webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
        }),
      }),
      tempRoot,
    );
    expect(result.verificationRetry).toBe(true);
    expect(result.verified).toBe(true);
    expect(JSON.stringify(result)).not.toContain("stable-webhook-secret");
  });

  it("persists canonical URLs when verification fails after stale Linear webhook reconciliation", async () => {
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue({
      ...previewResult,
      productionUrl: "https://harness-gui.vercel.app",
      webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
    });
    vi.mocked(reconcileLinearWebhookUrlForVerification).mockResolvedValue({
      attempted: true,
      reconciled: true,
      canonicalWebhookExists: false,
      matchingPreviousWebhookFound: true,
      manualSteps: [],
    });
    vi.mocked(readControlPlaneSetupState).mockResolvedValue({
      version: 1,
      vercel: {
        projectId: "proj-1",
        projectName: "harness-gui",
        productionUrl: "https://old-deployment.vercel.app",
        webhookUrl: "https://old-deployment.vercel.app/api/linear-webhook",
        endpointReachable: true,
        envVarPresence: {
          LINEAR_WEBHOOK_SECRET: "present",
          GITHUB_DISPATCH_TOKEN: "present",
          HARNESS_TEAM_KEY: "present",
        },
        linearWebhookVerified: true,
        deploymentRedeployRequired: true,
        appliedFingerprint: "preview-fingerprint",
      },
    });
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      probedAt: new Date().toISOString(),
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        verificationLinearWebhookSecret: "stable-webhook-secret",
        preserveGeneratedWebhookSecretFingerprint: true,
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      verifyOnly: true,
      cwd: tempRoot,
    });

    expect(result.verified).toBe(false);
    expect(updateControlPlaneSetupState).toHaveBeenCalledWith(
      expect.objectContaining({
        vercel: expect.objectContaining({
          productionUrl: "https://harness-gui.vercel.app",
          webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
        }),
      }),
      tempRoot,
    );
    expect(generateLinearWebhookSecret).not.toHaveBeenCalled();
  });

  it("returns manual recovery when stale URL drift has no matching previous Linear webhook", async () => {
    vi.mocked(previewVercelBridgeSetup).mockResolvedValue({
      ...previewResult,
      webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
    });
    vi.mocked(reconcileLinearWebhookUrlForVerification).mockResolvedValue({
      attempted: true,
      reconciled: false,
      canonicalWebhookExists: false,
      matchingPreviousWebhookFound: false,
      manualSteps: [
        "No matching Linear Issue webhook was found at the previously stored webhook URL.",
      ],
    });
    vi.mocked(readControlPlaneSetupState).mockResolvedValue({
      version: 1,
      vercel: {
        projectId: "proj-1",
        projectName: "harness-gui",
        productionUrl: "https://old-deployment.vercel.app",
        webhookUrl: "https://old-deployment.vercel.app/api/linear-webhook",
        endpointReachable: true,
        envVarPresence: {
          LINEAR_WEBHOOK_SECRET: "present",
          GITHUB_DISPATCH_TOKEN: "present",
          HARNESS_TEAM_KEY: "present",
        },
        linearWebhookVerified: true,
        deploymentRedeployRequired: true,
        appliedFingerprint: "preview-fingerprint",
      },
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        verificationLinearWebhookSecret: "stable-webhook-secret",
        preserveGeneratedWebhookSecretFingerprint: true,
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      verifyOnly: true,
      cwd: tempRoot,
    });

    expect(result.linearWebhookSetup.mode).toBe("existing-unverified");
    expect(result.linearWebhookSetup.manualSteps.join(" ")).toMatch(
      /No matching Linear Issue webhook/i,
    );
    expect(generateLinearWebhookSecret).not.toHaveBeenCalled();
    expect(ensureLinearIssueWebhook).not.toHaveBeenCalled();
  });

  it("reuses saved .env.local webhook secret on normal apply without regenerating or overwriting", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    await writeFile(
      paths.envLocal,
      [
        "LINEAR_API_KEY=lin_api_test",
        "LINEAR_WEBHOOK_SECRET=saved-local-secret",
      ].join("\n"),
      "utf8",
    );
    vi.mocked(resolveLinearWebhookCandidateSecret).mockResolvedValue({
      secret: "fresh-generated-secret",
      source: "generated",
      manualSteps: [],
    });
    const persistSpy = vi.spyOn(
      linearWebhookEnvLocal,
      "persistGeneratedLinearWebhookSecret",
    );

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
        willGenerateLinearWebhookSecret: true,
        verificationLinearWebhookSecret: "saved-local-secret",
        preserveGeneratedWebhookSecretFingerprint: true,
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(generateLinearWebhookSecret).not.toHaveBeenCalled();
    expect(persistSpy).not.toHaveBeenCalled();
    expect(ensureLinearIssueWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: "saved-local-secret",
        mutatePolicy: "setup",
      }),
    );
    expect(upsertVercelProjectEnvVar).toHaveBeenCalledWith(
      "vercel-token",
      expect.objectContaining({
        key: "LINEAR_WEBHOOK_SECRET",
        value: "saved-local-secret",
      }),
    );
    expect(result.linearWebhookSetup.mode).not.toBe("manual-copy");
    expect(result.linearWebhookSetup.manualCopySecret).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("saved-local-secret");
    const persistedState = vi.mocked(updateControlPlaneSetupState).mock.calls.at(
      -1,
    )?.[0];
    expect(JSON.stringify(persistedState)).not.toContain("saved-local-secret");

    persistSpy.mockRestore();
  });

  it("does not trigger another redeploy when pending state already has newDeploymentId", async () => {
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      probedAt: new Date().toISOString(),
    });
    vi.mocked(readControlPlaneSetupState).mockResolvedValue({
      version: 1,
      vercel: {
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
        redeployVerification: {
          actionId: "vercel-redeploy-existing",
          projectId: "proj-1",
          projectName: "harness-gui",
          webhookUrl: "https://harness-gui.vercel.app/api/linear-webhook",
          fingerprint: "preview-fingerprint",
          sourceDeploymentId: "dpl-source-1",
          newDeploymentId: "dpl-new-1",
          status: "building",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deadlineAt: new Date(Date.now() + 300_000).toISOString(),
          verifyAttempted: false,
        },
      },
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(triggerProductionRedeployOnce).not.toHaveBeenCalled();
    expect(result.setupPending).toBe(true);
    expect(result.pollActionId).toBe("vercel-redeploy-existing");
    expect(result.productionRedeployStatus).toBe("building");
  });

  it("attempts one setup rotation when matching Linear webhook secret is unreadable", async () => {
    vi.mocked(resolveLinearWebhookCandidateSecret).mockResolvedValue({
      source: "unreadable",
      manualSteps: ["Secret unreadable."],
      matchingWebhook: {
        id: "wh-1",
        url: "https://harness-gui.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
      },
    });
    vi.mocked(generateLinearWebhookSecret).mockReturnValue("generated-webhook-secret");

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(ensureLinearIssueWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: "generated-webhook-secret",
        mutatePolicy: "setup",
      }),
    );
    expect(result.candidateSecretSource).toBe("unreadable");
  });

  it("blocks repeated rotation when unreadable secret verification is retried", async () => {
    vi.mocked(readControlPlaneSetupState).mockResolvedValue({
      version: 1,
      vercel: {
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
        linearWebhookVerified: false,
        deploymentRedeployRequired: true,
        appliedFingerprint: "preview-fingerprint",
      },
    });
    vi.mocked(resolveLinearWebhookCandidateSecret).mockResolvedValue({
      source: "unreadable",
      manualSteps: ["Secret unreadable."],
      matchingWebhook: {
        id: "wh-1",
        url: "https://harness-gui.vercel.app/api/linear-webhook",
        enabled: true,
        resourceTypes: ["Issue"],
      },
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      verifyOnly: true,
      cwd: tempRoot,
    });

    expect(ensureLinearIssueWebhook).not.toHaveBeenCalled();
    expect(upsertVercelProjectEnvVar).not.toHaveBeenCalledWith(
      "vercel-token",
      expect.objectContaining({ key: "LINEAR_WEBHOOK_SECRET" }),
    );
    expect(result.linearWebhookSetup.mode).toBe("existing-unverified");
    expect(result.verified).toBe(false);
    expect(result.candidateSecretSource).toBe("unreadable");
  });

  it("returns setup-blocked when no READY production deployment exists for auto-redeploy", async () => {
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      probedAt: new Date().toISOString(),
    });
    vi.mocked(findLatestReadyProductionDeploymentId).mockResolvedValue(undefined);

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(result.productionRedeployTriggered).toBe(false);
    expect(result.productionRedeployStatus).toBe("no_source_deployment");
    expect(result.setupBlocked?.message).toMatch(/No READY production deployment/i);
    expect(triggerProductionRedeployOnce).not.toHaveBeenCalled();
  });

  it("returns failed redeploy state when production redeploy trigger fails", async () => {
    vi.mocked(runSignedWebhookProbe).mockResolvedValue({
      passed: false,
      result: "auth_failed",
      reason: "invalid_signature",
      probedAt: new Date().toISOString(),
    });
    vi.mocked(triggerProductionRedeployOnce).mockResolvedValue({
      status: "failed",
      sourceDeploymentId: "dpl-source-1",
      message: "Vercel API 500 on /v13/deployments",
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(result.productionRedeployTriggered).toBe(false);
    expect(result.productionRedeployStatus).toBe("failed");
    expect(result.setupBlocked?.message).toContain("Vercel API 500");
    expect(result.setupPending).toBeFalsy();
    expect(result.verified).toBe(false);
  });

  it("blocks initial apply when saved GITHUB_TOKEN is ineligible for dispatch", async () => {
    vi.mocked(assessGitHubDispatchTokenEligibility).mockResolvedValue({
      eligible: false,
      source: "manual-required",
      message:
        "Saved GITHUB_TOKEN cannot write repository contents for owner/harness.",
    });

    const result = await applyVercelBridgeSetup({
      plan: {
        vercelToken: "vercel-token",
        projectId: "proj-1",
        linearApiKey: "lin_api_test",
        derivedHarnessTeamKey: "WES",
        derivedGithubDispatchToken: "ghp_saved",
      },
      confirmed: true,
      fingerprint: "preview-fingerprint",
      cwd: tempRoot,
    });

    expect(result.setupBlocked?.message).toMatch(/cannot write repository contents/i);
    expect(result.verified).toBe(false);
    expect(upsertVercelProjectEnvVar).not.toHaveBeenCalled();
    expect(triggerProductionRedeployOnce).not.toHaveBeenCalled();
  });
});
