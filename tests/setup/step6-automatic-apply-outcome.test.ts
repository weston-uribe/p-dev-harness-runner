import { describe, expect, it } from "vitest";
import {
  assertStep6AutomaticApplyOutcomeInvariant,
  buildAuthoritativeCloudSecretsApplyEvidence,
  deriveStep6AutomaticApplyOutcome,
  deriveStep6ContinueEligibility,
  isCloudSecretsApplyEvidenceCurrent,
  shouldInvalidateCloudSecretsApplyEvidence,
} from "../../src/setup/first-run-readiness.js";
import { computeCloudSecretsConfigStateFingerprint } from "../../src/setup/control-plane-readiness.js";
import type { SetupGuiViewModel } from "../../src/setup/gui-view-model.js";
import type { RemoteSetupSummary } from "../../src/setup/remote-setup-summary.js";
import { HARNESS_ACTIONS_SECRET_NAMES } from "../../src/setup/remote-actions.js";
import type { ControlPlaneReadinessContext } from "../../src/setup/control-plane-types.js";

function completeLocalSummary(): SetupGuiViewModel {
  return {
    overview: {
      readyForLocalDoctor: true,
      configResolved: true,
      operatorConfigResolved: true,
      localFilesPresent: true,
    },
    localFiles: [],
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
    scaffoldPreviews: [],
    instructionPreviews: [],
    generatedPreviews: {},
    missingSteps: [],
    doctor: {
      checks: [],
      groups: [],
      failed: false,
      remoteChecksNote: "test",
    },
    deferredActions: [],
  };
}

function allSecretsPresentRemoteSummary(): RemoteSetupSummary {
  return {
    githubTokenConfigured: true,
    harnessDispatchRepo: "weston-uribe/p-dev-harness",
    harnessDispatchRepoResolved: true,
    harnessDispatchRepoSource: "explicit-config",
    harnessRepoAccess: "available",
    requireVercelProductionToken: false,
    harnessSecretStatuses: HARNESS_ACTIONS_SECRET_NAMES.map((name) => ({
      name,
      status: "present" as const,
    })),
    targetRepos: [],
    staleSmokeDiagnostics: {
      hasStaleConfig: false,
      findings: [],
      staleTargetRepos: [],
    },
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
    },
    linearTeamKeyFromConfig: "ENG",
  };
}

function automaticApplyResult() {
  return {
    actionId: "apply-harness-secrets",
    harnessDispatchRepo: "weston-uribe/p-dev-harness",
    writtenSecrets: [
      { name: "HARNESS_CONFIG_JSON_B64" as const, status: "updated" as const },
    ],
    skippedSecretNames: [
      "LINEAR_API_KEY",
      "CURSOR_API_KEY",
      "HARNESS_GITHUB_TOKEN",
    ] as const,
    fingerprint: "fp-apply",
    permission: {
      scope: "remote-secret-write" as const,
      label: "Write harness repo Actions secrets",
    },
  };
}

describe("step6 automatic apply outcome", () => {
  it("returns success with continue when authoritative evidence matches current config", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();
    const controlPlaneContext = completeControlPlaneContext();
    const evidence = buildAuthoritativeCloudSecretsApplyEvidence({
      applyResult: automaticApplyResult(),
      setupSummary: summary,
      controlPlaneContext,
      remoteSummary,
    });
    const eligibility = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: true,
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      controlPlaneContext,
      previewStaleCleared: true,
      uiState: { cloudSecretsApplyEvidence: evidence },
    });
    const fingerprint = computeCloudSecretsConfigStateFingerprint({
      setupSummary: summary,
      controlPlaneContext,
    });

    const outcome = deriveStep6AutomaticApplyOutcome({
      setupType: "automatic",
      loading: null,
      applyError: null,
      applyResult: automaticApplyResult(),
      verifiedAutomaticSuccess: true,
      cloudSecretsApplyEvidence: evidence,
      eligibility,
      currentConfigStateFingerprint: fingerprint,
      harnessDispatchRepo: remoteSummary.harnessDispatchRepo,
    });

    expect(outcome.kind).toBe("success");
    expect(outcome.canContinue).toBe(true);
    expect(eligibility.canContinue).toBe(true);
    assertStep6AutomaticApplyOutcomeInvariant({
      outcome,
      verifiedAutomaticSuccess: true,
      applyResult: automaticApplyResult(),
      loading: null,
      canContinue: true,
    });
  });

  it("returns stale-after-apply when config changes after a successful write", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();
    const applyTimeContext = completeControlPlaneContext();
    const postChangeContext: ControlPlaneReadinessContext = {
      state: applyTimeContext.state,
      linearTeamKeyFromConfig: "OPS",
    };
    const evidence = buildAuthoritativeCloudSecretsApplyEvidence({
      applyResult: automaticApplyResult(),
      setupSummary: summary,
      controlPlaneContext: applyTimeContext,
      remoteSummary,
    });
    const currentFingerprint = computeCloudSecretsConfigStateFingerprint({
      setupSummary: summary,
      controlPlaneContext: postChangeContext,
    });
    const eligibility = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: true,
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      controlPlaneContext: postChangeContext,
      previewStaleCleared: true,
      uiState: { cloudSecretsApplyEvidence: evidence },
    });

    const outcome = deriveStep6AutomaticApplyOutcome({
      setupType: "automatic",
      loading: null,
      applyError: null,
      applyResult: automaticApplyResult(),
      verifiedAutomaticSuccess: true,
      cloudSecretsApplyEvidence: evidence,
      eligibility,
      currentConfigStateFingerprint: currentFingerprint,
      harnessDispatchRepo: remoteSummary.harnessDispatchRepo,
    });

    expect(outcome.kind).toBe("stale-after-apply");
    expect(outcome.showRetry).toBe(true);
    expect(eligibility.canContinue).toBe(false);
  });

  it("does not treat manual verification evidence as current generated-config proof", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();
    const fingerprint = computeCloudSecretsConfigStateFingerprint({
      setupSummary: summary,
      controlPlaneContext: completeControlPlaneContext(),
    });

    expect(
      isCloudSecretsApplyEvidenceCurrent({
        evidence: undefined,
        currentConfigStateFingerprint: fingerprint,
        harnessDispatchRepo: remoteSummary.harnessDispatchRepo,
      }),
    ).toBe(false);
  });

  it("invalidates evidence when harness repo identity changes", () => {
    const summary = completeLocalSummary();
    const evidence = buildAuthoritativeCloudSecretsApplyEvidence({
      applyResult: automaticApplyResult(),
      setupSummary: summary,
      controlPlaneContext: completeControlPlaneContext(),
      remoteSummary: allSecretsPresentRemoteSummary(),
    });

    expect(
      shouldInvalidateCloudSecretsApplyEvidence({
        evidence,
        currentConfigStateFingerprint: evidence.configStateFingerprint,
        harnessDispatchRepo: "weston-uribe/other-harness",
      }),
    ).toBe(true);
  });

  it("never allows a silent dead-end outcome", () => {
    const summary = completeLocalSummary();
    const remoteSummary = allSecretsPresentRemoteSummary();
    const controlPlaneContext = completeControlPlaneContext();
    const evidence = buildAuthoritativeCloudSecretsApplyEvidence({
      applyResult: automaticApplyResult(),
      setupSummary: summary,
      controlPlaneContext,
      remoteSummary,
    });
    const eligibility = deriveStep6ContinueEligibility({
      summary: remoteSummary,
      setupSummary: summary,
      localReadinessComplete: true,
      staleSmokeDiagnostics: remoteSummary.staleSmokeDiagnostics,
      controlPlaneContext,
      previewStaleCleared: false,
      uiState: {
        cloudSecretsApplyEvidence: evidence,
        remoteSecretPreviewStale: true,
        cloudSecretsPreviewOpened: true,
      },
    });
    const outcome = deriveStep6AutomaticApplyOutcome({
      setupType: "automatic",
      loading: null,
      applyError: null,
      applyResult: automaticApplyResult(),
      verifiedAutomaticSuccess: true,
      cloudSecretsApplyEvidence: evidence,
      eligibility,
      currentConfigStateFingerprint: computeCloudSecretsConfigStateFingerprint({
        setupSummary: summary,
        controlPlaneContext,
      }),
      harnessDispatchRepo: remoteSummary.harnessDispatchRepo,
    });

    expect(outcome.kind).toBe("success-blocked");
    assertStep6AutomaticApplyOutcomeInvariant({
      outcome,
      verifiedAutomaticSuccess: true,
      applyResult: automaticApplyResult(),
      loading: null,
      canContinue: false,
    });
  });
});
