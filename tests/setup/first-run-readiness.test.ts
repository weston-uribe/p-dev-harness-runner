import { describe, expect, it } from "vitest";
import {
  collectLocalReadinessBlockers,
  collectLocalSetupBlockers,
  collectCloudSecretsBlockers,
  collectTargetWorkflowBlockers,
  collectRemoteSetupBlockers,
  deriveFirstRunReadiness,
  deriveStep6ContinueEligibility,
  deriveStep6RemoteActionEligibility,
  projectMissingStepsFromReadiness,
  buildCloudSecretsApplyEvidence,
  buildAuthoritativeCloudSecretsApplyEvidence,
  shouldInvalidateCloudSecretsApplyEvidence,
  isCloudSecretsApplyEvidenceCurrent,
  filterResolvedCloudSecretsBlockers,
  harnessConfigJsonB64WasWritten,
  isCloudSecretsStaleLinearConfigResolved,
} from "../../src/setup/first-run-readiness.js";
import { computeCloudSecretsConfigStateFingerprint } from "../../src/setup/control-plane-readiness.js";
import type { SetupGuiViewModel } from "../../src/setup/gui-view-model.js";
import type { RemoteSetupSummary } from "../../src/setup/remote-setup-summary.js";
import { HARNESS_ACTIONS_SECRET_NAMES } from "../../src/setup/remote-actions.js";
import type { ControlPlaneReadinessContext } from "../../src/setup/control-plane-types.js";
import type { HarnessRepoProvisioningSummary } from "../../src/setup/harness-repo-provisioning.js";

function baseSummary(
  overrides: Partial<SetupGuiViewModel> = {},
): SetupGuiViewModel {
  return {
    overview: {
      readyForLocalDoctor: false,
      configResolved: false,
      operatorConfigResolved: false,
      localFilesPresent: false,
    },
    localFiles: [
      { label: ".env.local", path: "/tmp/.env.local", exists: false },
      {
        label: ".harness/config.local.json",
        path: "/tmp/.harness/config.local.json",
        exists: false,
      },
    ],
    configSource: {
      kind: "HARNESS_CONFIG_PATH",
      label: ".harness/config.local.json",
      resolved: false,
    },
    envKeyPresence: {
      LINEAR_API_KEY: false,
      CURSOR_API_KEY: false,
      GITHUB_TOKEN: false,
      VERCEL_TOKEN: false,
      HARNESS_CONFIG_PATH: false,
    },
    scaffoldPreviews: [],
    instructionPreviews: [],
    generatedPreviews: {},
    missingSteps: [],
    doctor: {
      checks: [
        {
          label: "harness config valid",
          ok: false,
          detail: "config could not be resolved",
        },
      ],
      groups: [],
      failed: true,
      remoteChecksNote: "CLI doctor required for live provider checks.",
    },
    deferredActions: [],
    ...overrides,
  };
}

function completeLocalSummary(): SetupGuiViewModel {
  return baseSummary({
    overview: {
      readyForLocalDoctor: true,
      configResolved: true,
      operatorConfigResolved: true,
      localFilesPresent: true,
    },
    localFiles: [
      { label: ".env.local", path: "/tmp/.env.local", exists: true },
      {
        label: ".harness/config.local.json",
        path: "/tmp/.harness/config.local.json",
        exists: true,
      },
    ],
    configSource: {
      kind: "HARNESS_CONFIG_PATH",
      label: ".harness/config.local.json",
      resolved: true,
    },
    configSummary: {
      repoCount: 1,
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "dev",
          productionBranch: "main",
        },
      ],
      allowedTargetRepos: ["https://github.com/owner/example-target-app"],
      closureValid: true,
      model: {
        resolvedModelId: "composer-2.5",
        source: "default",
        configuredModelId: undefined,
        policyNote: "test",
      },
    },
    envKeyPresence: {
      LINEAR_API_KEY: true,
      CURSOR_API_KEY: true,
      GITHUB_TOKEN: true,
      VERCEL_TOKEN: true,
      HARNESS_CONFIG_PATH: true,
    },
    doctor: {
      checks: [
        { label: "harness config valid", ok: true },
        { label: ".env.local present", ok: true },
        { label: ".harness/config.local.json present", ok: true },
        {
          label: "LINEAR_API_KEY set",
          ok: false,
          skipped: true,
          detail: "CLI-only",
        },
      ],
      groups: [],
      failed: false,
      remoteChecksNote: "CLI doctor required for live provider checks.",
    },
  });
}

function baseRemoteSummary(
  overrides: Partial<RemoteSetupSummary> = {},
): RemoteSetupSummary {
  return {
    githubTokenConfigured: false,
    harnessDispatchRepo: "owner/harness",
    harnessDispatchRepoResolved: true,
    harnessDispatchRepoSource: "git remote",
    harnessRepoAccess: "unknown",
    harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
      name,
      status: "unknown" as const,
    })),
    targetRepos: [],
    staleSmokeDiagnostics: {
      hasStaleConfig: false,
      findings: [],
      staleTargetRepos: [],
    },
    ...overrides,
  };
}

function completeControlPlaneContext(): ControlPlaneReadinessContext {
  return {
    state: {
      version: 1,
      linear: {
        teamMode: "existing",
        teamId: "team-1",
        teamKey: "ENG",
        teamName: "Engineering",
        projectMode: "existing",
        projectId: "proj-1",
        projectName: "Harness",
        statusCoverageComplete: true,
      },
      vercel: {
        projectId: "prj-1",
        projectName: "harness-bridge",
        productionUrl: "https://harness-bridge.vercel.app",
        webhookUrl: "https://harness-bridge.vercel.app/api/linear-webhook",
        endpointReachable: true,
        envVarPresence: {
          LINEAR_WEBHOOK_SECRET: "present",
          GITHUB_DISPATCH_TOKEN: "present",
          HARNESS_TEAM_KEY: "present",
        },
        linearWebhookVerified: true,
        signedProbeVerified: true,
        deploymentRedeployRequired: false,
      },
    },
    linearTeamKeyFromConfig: "ENG",
  };
}

function allSecretsPresentRemoteSummary(
  overrides: Partial<RemoteSetupSummary> = {},
): RemoteSetupSummary {
  return baseRemoteSummary({
    githubTokenConfigured: true,
    harnessRepoAccess: "available",
    harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
      name,
      status: "present" as const,
    })),
    ...overrides,
  });
}

function harnessProvisioningSummary(
  overrides: Partial<HarnessRepoProvisioningSummary> = {},
): HarnessRepoProvisioningSummary {
  return {
    runtimeMode: "packaged",
    eligible: true,
    state: "repo-absent",
    harnessDispatchRepo: null,
    authenticatedLogin: null,
    message: "Packaged workspace provisioning has not completed yet.",
    recoverable: true,
    connectedAutomatically: false,
    verifiedSavedRepo: false,
    ...overrides,
  };
}

function staleLinearControlPlaneContext(): ControlPlaneReadinessContext {
  return {
    state: {
      version: 1,
      linear: {
        teamMode: "existing",
        teamId: "team-1",
        teamKey: "ENG",
        teamName: "Engineering",
        projectMode: "existing",
        projectId: "proj-1",
        projectName: "Harness",
        statusCoverageComplete: true,
      },
    },
    linearTeamKeyFromConfig: "OPS",
  };
}

function deriveReadiness(input: {
  summary: SetupGuiViewModel;
  remoteSummary: RemoteSetupSummary;
  uiState?: Parameters<typeof deriveFirstRunReadiness>[0]["uiState"];
  staleSmokeDiagnostics?: Parameters<typeof deriveFirstRunReadiness>[0]["staleSmokeDiagnostics"];
  controlPlaneContext?: ControlPlaneReadinessContext;
  harnessProvisioningSummary?: HarnessRepoProvisioningSummary;
}) {
  return deriveFirstRunReadiness({
    ...input,
    controlPlaneContext:
      input.controlPlaneContext ?? completeControlPlaneContext(),
  });
}

describe("first-run-readiness", () => {
  it("blocks local setup when .env.local is missing", () => {
    const blockers = collectLocalSetupBlockers(baseSummary());
    expect(blockers[0]?.id).toBe("missing-env-local");
    expect(blockers[0]?.message).toContain("Setup needed");
    expect(blockers[0]?.tone).toBe("setup_needed");
  });

  it("blocks connect services when CURSOR_API_KEY is missing before remote warnings", () => {
    const summary = baseSummary({
      localFiles: [
        { label: ".env.local", path: "/tmp/.env.local", exists: true },
        {
          label: ".harness/config.local.json",
          path: "/tmp/.harness/config.local.json",
          exists: true,
        },
      ],
      envKeyPresence: {
        LINEAR_API_KEY: true,
        CURSOR_API_KEY: false,
        GITHUB_TOKEN: true,
        VERCEL_TOKEN: true,
        HARNESS_CONFIG_PATH: true,
      },
    });

    const readiness = deriveReadiness({
      summary,
      remoteSummary: baseRemoteSummary({ githubTokenConfigured: true }),
      controlPlaneContext: { state: null },
    });

    expect(readiness.currentStepId).toBe("connect-services");
    expect(readiness.highestPriorityBlocker?.id).toBe("missing-cursor-key");
    expect(
      readiness.nonBlockingWarnings.some((warning) =>
        warning.id.includes("doctor-skipped"),
      ),
    ).toBe(false);
  });

  it("keeps Step 1 current until packaged harness provisioning is persisted", () => {
    const summary = baseSummary({
      envKeyPresence: {
        LINEAR_API_KEY: true,
        CURSOR_API_KEY: true,
        GITHUB_TOKEN: true,
        VERCEL_TOKEN: true,
        HARNESS_CONFIG_PATH: false,
      },
    });

    const readiness = deriveReadiness({
      summary,
      remoteSummary: baseRemoteSummary({ githubTokenConfigured: true }),
      controlPlaneContext: { state: null },
      harnessProvisioningSummary: harnessProvisioningSummary({
        state: "repo-created-pending-verification",
        harnessDispatchRepo: "owner/p-dev-harness",
        message: "Harness workspace provisioning is incomplete.",
      }),
    });

    expect(readiness.currentStepId).toBe("connect-services");
    expect(
      readiness.steps
        .find((step) => step.id === "connect-services")
        ?.blockers.some(
          (blocker) => blocker.id === "harness-workspace-not-provisioned",
        ),
    ).toBe(true);
  });

  it("allows Step 2 after verified persisted packaged harness provisioning", () => {
    const summary = baseSummary({
      envKeyPresence: {
        LINEAR_API_KEY: true,
        CURSOR_API_KEY: true,
        GITHUB_TOKEN: true,
        VERCEL_TOKEN: true,
        HARNESS_CONFIG_PATH: false,
      },
    });

    const readiness = deriveReadiness({
      summary,
      remoteSummary: baseRemoteSummary({ githubTokenConfigured: true }),
      controlPlaneContext: { state: null },
      harnessProvisioningSummary: harnessProvisioningSummary({
        state: "verified-and-persisted",
        harnessDispatchRepo: "owner/p-dev-harness",
        message: "Connected to validated harness workspace.",
        recoverable: false,
        verifiedSavedRepo: true,
      }),
    });

    expect(readiness.currentStepId).toBe("linear-workspace");
  });

  it("keeps source mode Step 1 skip behavior for provisioning", () => {
    const summary = baseSummary({
      envKeyPresence: {
        LINEAR_API_KEY: true,
        CURSOR_API_KEY: true,
        GITHUB_TOKEN: true,
        VERCEL_TOKEN: true,
        HARNESS_CONFIG_PATH: false,
      },
    });

    const readiness = deriveReadiness({
      summary,
      remoteSummary: baseRemoteSummary({ githubTokenConfigured: true }),
      controlPlaneContext: { state: null },
      harnessProvisioningSummary: harnessProvisioningSummary({
        runtimeMode: "source",
        eligible: false,
        state: "skipped-source-mode",
        recoverable: false,
      }),
    });

    expect(readiness.currentStepId).toBe("linear-workspace");
  });

  it("blocks step 2 on config parse errors with PM-readable copy", () => {
    const summary = completeLocalSummary();
    summary.configSource.parseError = "Invalid harness config: repos: Required";
    summary.overview.configResolved = false;
    summary.overview.readyForLocalDoctor = false;

    const readiness = deriveReadiness({
      summary,
      remoteSummary: baseRemoteSummary(),
    });

    expect(readiness.currentStepId).toBe("local-readiness");
    expect(
      readiness.highestPriorityBlocker?.message,
    ).toContain("does not parse");
    expect(JSON.stringify(readiness)).not.toContain("super-secret");
  });

  it("blocks step 2 when allowedTargetRepos closure is invalid", () => {
    const summary = completeLocalSummary();
    if (summary.configSummary) {
      summary.configSummary.closureValid = false;
    }

    const blockers = collectLocalReadinessBlockers(summary).blockers;
    expect(blockers.some((blocker) => blocker.id === "allowed-target-repos-closure")).toBe(
      true,
    );
  });

  it("blocks step 3 when GitHub token or harness repo access is missing", () => {
    const summary = completeLocalSummary();
    const remoteSummary = baseRemoteSummary({
      githubTokenConfigured: false,
      harnessRepoAccess: "denied",
    });

    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: true },
    });
    const blockers = collectRemoteSetupBlockers(
      summary,
      remoteSummary,
      { localReadinessReviewed: true },
      completeControlPlaneContext(),
    ).blockers;

    expect(readiness.currentStepId).toBe("cloud-secrets");
    expect(blockers.some((blocker) => blocker.id === "missing-github-token-remote")).toBe(
      true,
    );
    expect(blockers.some((blocker) => blocker.id === "harness-repo-access-denied")).toBe(
      true,
    );
  });

  it("advances to cloud secrets after local readiness is reviewed", () => {
    const summary = completeLocalSummary();
    const remoteSummary = baseRemoteSummary({
      githubTokenConfigured: false,
      harnessRepoAccess: "denied",
    });

    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: true },
    });

    expect(readiness.currentStepId).toBe("cloud-secrets");
  });

  it("advances to target workflow after cloud secrets are reviewed", () => {
    const summary = completeLocalSummary();
    const remoteSummary = baseRemoteSummary({
      githubTokenConfigured: true,
      harnessRepoAccess: "available",
      harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
        name,
        status: "present" as const,
      })),
      targetRepos: [
        {
          repoConfigId: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          productionBranch: "main",
          repoAccess: "available",
          workflowStatus: "missing",
          harnessDispatchRepo: "owner/harness",
        },
      ],
    });

    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: {
        localReadinessReviewed: true,
        cloudSecretsReviewed: true,
      },
    });

    expect(readiness.currentStepId).toBe("target-workflow");
  });

  it("keeps local readiness as the current step after local setup files exist", () => {
    const summary = completeLocalSummary();
    const readiness = deriveReadiness({
      summary,
      remoteSummary: baseRemoteSummary({ githubTokenConfigured: true }),
    });

    expect(readiness.currentStepId).toBe("local-readiness");
    expect(readiness.localReadinessBlockersCleared).toBe(true);
    expect(readiness.localReadinessReviewed).toBe(false);
  });

  it("routes secret blockers to cloud-secrets and workflow blockers to target-workflow", () => {
    const summary = completeLocalSummary();
    const remoteSummary = baseRemoteSummary({
      githubTokenConfigured: true,
      harnessRepoAccess: "available",
      harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
        name,
        status: name === "CURSOR_API_KEY" ? "missing" : "present",
      })),
      targetRepos: [
        {
          repoConfigId: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          productionBranch: "main",
          repoAccess: "available",
          workflowStatus: "missing",
          harnessDispatchRepo: "owner/harness",
        },
      ],
    });

    const secretBlockers = collectCloudSecretsBlockers(summary, remoteSummary).blockers;
    const workflowBlockers = collectTargetWorkflowBlockers(
      summary,
      remoteSummary,
    ).blockers;

    expect(secretBlockers.every((blocker) => blocker.stepId === "cloud-secrets")).toBe(
      true,
    );
    expect(
      workflowBlockers.every((blocker) => blocker.stepId === "target-workflow"),
    ).toBe(true);
  });

  it("blocks cloud secrets and target workflow when incomplete", () => {
    const summary = completeLocalSummary();
    const remoteSummary = baseRemoteSummary({
      githubTokenConfigured: true,
      harnessRepoAccess: "available",
      harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
        name,
        status: name === "CURSOR_API_KEY" ? "missing" : "present",
      })),
      targetRepos: [
        {
          repoConfigId: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          productionBranch: "main",
          repoAccess: "available",
          workflowStatus: "missing",
          harnessDispatchRepo: "owner/harness",
        },
      ],
    });

    const blockers = collectRemoteSetupBlockers(summary, remoteSummary).blockers;
    expect(blockers.some((blocker) => blocker.id.includes("missing-harness-secret"))).toBe(
      true,
    );
    expect(blockers.some((blocker) => blocker.id.includes("target-workflow"))).toBe(
      true,
    );
  });

  it("prioritizes blockers before warnings", () => {
    const summary = completeLocalSummary();
    const remoteSummary = baseRemoteSummary({
      githubTokenConfigured: true,
      harnessRepoAccess: "available",
      harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
        name,
        status: "missing",
      })),
      targetRepos: [
        {
          repoConfigId: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          productionBranch: "main",
          repoAccess: "unknown",
          workflowStatus: "unknown",
          harnessDispatchRepo: "owner/harness",
        },
      ],
    });

    const readiness = deriveReadiness({ summary, remoteSummary });
    expect(readiness.highestPriorityBlocker?.blocking).toBe(true);
    expect(readiness.nonBlockingWarnings.length).toBeGreaterThan(0);
    expect(readiness.highestPriorityBlocker?.priority).toBeLessThan(
      readiness.nonBlockingWarnings[0]!.priority,
    );
  });

  it("marks step 4 ready when all prerequisites are complete", () => {
    const summary = completeLocalSummary();
    const remoteSummary = baseRemoteSummary({
      githubTokenConfigured: true,
      harnessRepoAccess: "available",
      harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
        name,
        status: "present",
      })),
      targetRepos: [
        {
          repoConfigId: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          productionBranch: "main",
          repoAccess: "available",
          workflowStatus: "present",
          harnessDispatchRepo: "owner/harness",
        },
      ],
    });

    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: {
        localReadinessReviewed: true,
        cloudSecretsReviewed: true,
      },
    });

    expect(readiness.readyForFirstRun).toBe(true);
    expect(readiness.currentStepId).toBe("ready-for-first-run");
    expect(readiness.prohibitedActionsNote).toContain("does not trigger harness phases");
  });

  it("projects missing steps from blocking readiness entries", () => {
    const readiness = deriveReadiness({
      summary: baseSummary(),
      remoteSummary: baseRemoteSummary(),
      controlPlaneContext: { state: null },
    });

    const missingSteps = projectMissingStepsFromReadiness(readiness);
    expect(missingSteps.length).toBeGreaterThan(0);
    expect(missingSteps.some((step) => step.id === "missing-env-local")).toBe(true);
  });

  it("treats stale local preview as a blocker", () => {
    const summary = completeLocalSummary();
    const readiness = deriveReadiness({
      summary,
      remoteSummary: baseRemoteSummary({ githubTokenConfigured: true }),
      uiState: { localPreviewStale: true },
    });

    expect(
      readiness.steps
        .find((step) => step.id === "local-setup")
        ?.blockers.some((blocker) => blocker.id === "local-preview-stale"),
    ).toBe(true);
  });

  it("prioritizes stale smoke repo over generic GitHub access denied", () => {
    const summary = completeLocalSummary();
    const staleSmokeDiagnostics = {
      hasStaleConfig: true,
      findings: [
        {
          kind: "harness-dispatch" as const,
          value: "weston-uribe/pdh-smoke-harness-20260709-191523",
          source: "GITHUB_DISPATCH_REPOSITORY",
        },
      ],
      staleHarnessDispatchRepo: "weston-uribe/pdh-smoke-harness-20260709-191523",
      staleTargetRepos: [],
      suggestedHarnessDispatchRepo:
        "weston-uribe/agentic-product-development-harness",
    };
    const remoteSummary = baseRemoteSummary({
      githubTokenConfigured: true,
      harnessDispatchRepo: "weston-uribe/pdh-smoke-harness-20260709-191523",
      harnessRepoAccess: "denied",
      staleSmokeDiagnostics,
    });

    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      staleSmokeDiagnostics,
      controlPlaneContext: completeControlPlaneContext(),
    });

    expect(readiness.highestPriorityBlocker?.id).toBe("stale-smoke-dispatch-repo");
    expect(readiness.primaryTask?.primaryCtaLabel).toBe("Preview setup files");
    expect(readiness.highestPriorityBlocker?.action).not.toContain(
      "Grant repo and Actions secret permissions",
    );
    expect(readiness.remoteSetupBlockedByUpstream).toBe(true);
    expect(
      readiness.nonBlockingWarnings.some((warning) =>
        warning.id.includes("harness-secret-unknown"),
      ),
    ).toBe(false);
  });

  it("uses actionable copy for non-stale GitHub access denied", () => {
    const summary = completeLocalSummary();
    const remoteSummary = baseRemoteSummary({
      githubTokenConfigured: true,
      harnessDispatchRepo: "owner/harness",
      harnessRepoAccess: "denied",
    });

    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: true },
    });

    expect(readiness.highestPriorityBlocker?.message).toContain(
      "I tried to check owner/harness and GitHub denied access.",
    );
    expect(readiness.highestPriorityBlocker?.action).toContain(
      "Return to Step 4",
    );
  });

  it("derives Step 6 remote action eligibility from harness repo access state", () => {
    expect(
      deriveStep6RemoteActionEligibility(
        baseRemoteSummary({
          githubTokenConfigured: false,
          harnessDispatchRepoResolved: false,
        }),
      ),
    ).toMatchObject({
      allowed: false,
      route: "connect-services",
    });

    expect(
      deriveStep6RemoteActionEligibility(
        baseRemoteSummary({
          githubTokenConfigured: true,
          harnessDispatchRepoResolved: false,
        }),
      ),
    ).toMatchObject({
      allowed: false,
      route: "step4-harness-repo",
    });

    expect(
      deriveStep6RemoteActionEligibility(
        baseRemoteSummary({
          githubTokenConfigured: true,
          harnessDispatchRepoResolved: true,
          harnessRepoAccess: "available",
        }),
      ),
    ).toEqual({ allowed: true });
  });
});


function automaticApplyResult(
  overrides: Partial<{
    writtenSecrets: Array<{
      name: (typeof HARNESS_ACTIONS_SECRET_NAMES)[number];
      status: "created" | "updated";
    }>;
    skippedSecretNames: (typeof HARNESS_ACTIONS_SECRET_NAMES)[number][];
    fingerprint: string;
  }> = {},
) {
  return {
    actionId: "apply-harness-secrets",
    harnessDispatchRepo: "owner/harness",
    writtenSecrets: overrides.writtenSecrets ?? [
      { name: "HARNESS_CONFIG_JSON_B64" as const, status: "updated" as const },
    ],
    skippedSecretNames: overrides.skippedSecretNames ?? [],
    fingerprint: overrides.fingerprint ?? "fp",
    permission: {
      scope: "remote-secret-write" as const,
      label: "Write harness repo Actions secrets",
    },
  };
}

describe("cloud secrets apply evidence", () => {
  it("builds evidence with config-state fingerprint and config secret write flag", () => {
    const summary = completeLocalSummary();
    const applyResult = automaticApplyResult();

    const evidence = buildCloudSecretsApplyEvidence({
      applyResult,
      setupSummary: summary,
      controlPlaneContext: completeControlPlaneContext(),
    });

    expect(evidence.path).toBe("automatic");
    expect(evidence.applyFingerprint).toBe("fp");
    expect(evidence.harnessConfigJsonB64Written).toBe(true);
    expect(evidence.configStateFingerprint).toBe(
      computeCloudSecretsConfigStateFingerprint({
        setupSummary: summary,
        controlPlaneContext: completeControlPlaneContext(),
      }),
    );
  });

  it("detects when HARNESS_CONFIG_JSON_B64 was written", () => {
    expect(
      harnessConfigJsonB64WasWritten(
        automaticApplyResult({
          writtenSecrets: [{ name: "HARNESS_CONFIG_JSON_B64", status: "created" }],
        }),
      ),
    ).toBe(true);
    expect(
      harnessConfigJsonB64WasWritten(
        automaticApplyResult({
          writtenSecrets: [{ name: "LINEAR_API_KEY", status: "updated" }],
          skippedSecretNames: ["HARNESS_CONFIG_JSON_B64"],
        }),
      ),
    ).toBe(false);
  });

  it("resolves stale linear config only when evidence matches current fingerprint", () => {
    const summary = completeLocalSummary();
    const controlPlaneContext = staleLinearControlPlaneContext();
    const fingerprint = computeCloudSecretsConfigStateFingerprint({
      setupSummary: summary,
      controlPlaneContext,
    });
    const evidence = buildCloudSecretsApplyEvidence({
      applyResult: automaticApplyResult(),
      setupSummary: summary,
      controlPlaneContext,
    });

    expect(
      isCloudSecretsStaleLinearConfigResolved({
        evidence,
        currentConfigStateFingerprint: fingerprint,
      }),
    ).toBe(true);
    expect(
      isCloudSecretsStaleLinearConfigResolved({
        evidence,
        currentConfigStateFingerprint: "stale-fingerprint",
      }),
    ).toBe(false);
  });

  it("does not block on remote-secret-preview-stale until preview was opened", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();

    const withoutOpened = collectCloudSecretsBlockers(
      summary,
      remoteSummary,
      { remoteSecretPreviewStale: true },
    ).blockers;
    expect(
      withoutOpened.some((blocker) => blocker.id === "remote-secret-preview-stale"),
    ).toBe(false);

    const withOpened = collectCloudSecretsBlockers(summary, remoteSummary, {
      remoteSecretPreviewStale: true,
      cloudSecretsPreviewOpened: true,
    }).blockers;
    expect(
      withOpened.some((blocker) => blocker.id === "remote-secret-preview-stale"),
    ).toBe(true);
  });

  it("filters cloud-secrets-stale-linear-config using matching evidence", () => {
    const summary = completeLocalSummary();
    const controlPlaneContext = staleLinearControlPlaneContext();
    const blockers = collectCloudSecretsBlockers(
      summary,
      allSecretsPresentRemoteSummary(),
      undefined,
      undefined,
      controlPlaneContext,
    ).blockers;
    const fingerprint = computeCloudSecretsConfigStateFingerprint({
      setupSummary: summary,
      controlPlaneContext,
    });
    const evidence = buildCloudSecretsApplyEvidence({
      applyResult: automaticApplyResult(),
      setupSummary: summary,
      controlPlaneContext,
    });

    const filtered = filterResolvedCloudSecretsBlockers({
      blockers,
      evidence,
      currentConfigStateFingerprint: fingerprint,
    });

    expect(
      blockers.some(
        (blocker) => blocker.id === "cloud-secrets-stale-linear-config",
      ),
    ).toBe(true);
    expect(
      filtered.some(
        (blocker) => blocker.id === "cloud-secrets-stale-linear-config",
      ),
    ).toBe(false);
  });
});

describe("deriveStep6ContinueEligibility", () => {
  it("allows Continue when all five conditions pass", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();
    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: true },
    });

    const eligibility = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: readiness.localReadinessComplete,
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      controlPlaneContext: completeControlPlaneContext(),
      previewStaleCleared: true,
      uiState: {
        cloudSecretsApplyEvidence: buildCloudSecretsApplyEvidence({
          applyResult: automaticApplyResult(),
          setupSummary: summary,
          controlPlaneContext: completeControlPlaneContext(),
        }),
      },
    });

    expect(eligibility.canContinue).toBe(true);
    expect(eligibility.postApplyVerificationReady).toBe(true);
    expect(eligibility.blockers).toHaveLength(0);
  });

  it("blocks Continue when harness dispatch repo is unresolved", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary({
      harnessDispatchRepoResolved: false,
    });
    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: true },
    });

    const eligibility = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: readiness.localReadinessComplete,
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      previewStaleCleared: true,
    });

    expect(eligibility.canContinue).toBe(false);
    expect(eligibility.postApplyVerificationReady).toBe(false);
  });

  it("blocks Continue when GitHub repo access is denied", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary({
      harnessRepoAccess: "denied",
    });
    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: true },
    });

    const eligibility = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: readiness.localReadinessComplete,
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      previewStaleCleared: true,
    });

    expect(eligibility.canContinue).toBe(false);
    expect(
      eligibility.blockers.some(
        (blocker) => blocker.id === "harness-repo-access-denied",
      ),
    ).toBe(true);
  });

  it("blocks Continue when required secrets are missing", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary({
      harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
        name,
        status: name === "LINEAR_API_KEY" ? ("missing" as const) : ("present" as const),
      })),
    });
    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: true },
    });

    const eligibility = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: readiness.localReadinessComplete,
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      previewStaleCleared: true,
    });

    expect(eligibility.canContinue).toBe(false);
    expect(eligibility.postApplyVerificationReady).toBe(false);
    expect(
      eligibility.blockers.some((blocker) =>
        blocker.id.startsWith("missing-harness-secret-"),
      ),
    ).toBe(true);
  });

  it("blocks Continue when local readiness is incomplete", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();
    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: false },
    });

    const eligibility = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: readiness.localReadinessComplete,
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      previewStaleCleared: true,
    });

    expect(eligibility.canContinue).toBe(false);
    expect(readiness.localReadinessComplete).toBe(false);
  });

  it("clears remote-secret-preview-stale when previewStaleCleared is true", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();
    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: true, remoteSecretPreviewStale: true },
    });

    const blocked = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: readiness.localReadinessComplete,
      uiState: {
        remoteSecretPreviewStale: true,
        cloudSecretsPreviewOpened: true,
      },
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      previewStaleCleared: false,
    });
    const cleared = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: readiness.localReadinessComplete,
      uiState: {
        remoteSecretPreviewStale: true,
        cloudSecretsPreviewOpened: true,
      },
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      previewStaleCleared: true,
    });

    expect(
      blocked.blockers.some(
        (blocker) => blocker.id === "remote-secret-preview-stale",
      ),
    ).toBe(true);
    expect(cleared.canContinue).toBe(true);
    expect(
      cleared.blockers.some(
        (blocker) => blocker.id === "remote-secret-preview-stale",
      ),
    ).toBe(false);
  });

  it("resolves cloud-secrets-stale-linear-config when HARNESS_CONFIG_JSON_B64 was written", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();
    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: true },
      controlPlaneContext: completeControlPlaneContext(),
    });

    expect(readiness.localReadinessComplete).toBe(true);

    const staleContext = staleLinearControlPlaneContext();
    const eligibility = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: readiness.localReadinessComplete,
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      controlPlaneContext: staleContext,
      previewStaleCleared: true,
      uiState: {
        cloudSecretsApplyEvidence: buildCloudSecretsApplyEvidence({
          applyResult: automaticApplyResult({
            writtenSecrets: [
              { name: "HARNESS_CONFIG_JSON_B64", status: "created" },
            ],
          }),
          setupSummary: summary,
          controlPlaneContext: staleContext,
        }),
      },
    });

    expect(eligibility.canContinue).toBe(true);
    expect(eligibility.postApplyVerificationReady).toBe(true);
    expect(eligibility.blockers).toHaveLength(0);
  });

  it("keeps cloud-secrets-stale-linear-config when config secret was not written", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();
    const readiness = deriveReadiness({
      summary,
      remoteSummary,
      uiState: { localReadinessReviewed: true },
      controlPlaneContext: completeControlPlaneContext(),
    });

    const staleContext = staleLinearControlPlaneContext();
    const eligibility = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: readiness.localReadinessComplete,
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      controlPlaneContext: staleContext,
      previewStaleCleared: true,
      uiState: {
        cloudSecretsApplyEvidence: buildCloudSecretsApplyEvidence({
          applyResult: automaticApplyResult({
            writtenSecrets: [{ name: "LINEAR_API_KEY", status: "updated" }],
            skippedSecretNames: ["HARNESS_CONFIG_JSON_B64"],
          }),
          setupSummary: summary,
          controlPlaneContext: staleContext,
        }),
      },
    });

    expect(eligibility.canContinue).toBe(false);
    expect(
      eligibility.blockers.some(
        (blocker) => blocker.id === "cloud-secrets-stale-linear-config",
      ),
    ).toBe(true);
  });
});

describe("authoritative cloud secrets apply evidence", () => {
  it("includes remote summary proof fields without secret values", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary({
      harnessDispatchRepo: "weston-uribe/p-dev-harness",
      harnessDispatchRepoSource: "explicit-config",
    });
    const evidence = buildAuthoritativeCloudSecretsApplyEvidence({
      applyResult: automaticApplyResult(),
      setupSummary: summary,
      controlPlaneContext: completeControlPlaneContext(),
      remoteSummary,
    });

    expect(evidence.harnessDispatchRepo).toBe("weston-uribe/p-dev-harness");
    expect(evidence.harnessDispatchRepoResolved).toBe(true);
    expect(evidence.harnessRepoAccess).toBe("available");
    expect(evidence.postApplyVerificationReady).toBe(true);
    expect(evidence.secretPresence?.allPresent).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("sentinel");
  });

  it("treats persisted evidence as current across presentation changes", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();
    const controlPlaneContext = completeControlPlaneContext();
    const evidence = buildAuthoritativeCloudSecretsApplyEvidence({
      applyResult: automaticApplyResult(),
      setupSummary: summary,
      controlPlaneContext,
      remoteSummary,
    });
    const fingerprint = computeCloudSecretsConfigStateFingerprint({
      setupSummary: summary,
      controlPlaneContext,
    });

    expect(
      isCloudSecretsApplyEvidenceCurrent({
        evidence,
        currentConfigStateFingerprint: fingerprint,
        harnessDispatchRepo: remoteSummary.harnessDispatchRepo,
      }),
    ).toBe(true);
    expect(
      shouldInvalidateCloudSecretsApplyEvidence({
        evidence,
        currentConfigStateFingerprint: fingerprint,
        harnessDispatchRepo: remoteSummary.harnessDispatchRepo,
      }),
    ).toBe(false);
  });
});
