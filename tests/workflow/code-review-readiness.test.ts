import { describe, expect, it } from "vitest";
import {
  buildCodeReviewPhaseExecutionFreeze,
  buildCodeReviewExecutionEligibilityDiagnostic,
  buildCodeReviewReadinessDiagnostic,
  evaluateCodeReviewExecutionEligibility,
  evaluateCodeReviewReadinessSync,
  resolveDefinitionWithCodeReviewReadiness,
} from "../../src/workflow/code-review-readiness.js";
import { createImplementationArtifactIdentity } from "../../src/workflow/implementation-artifact.js";
import { evaluateTransition } from "../../src/workflow/transition-engine.js";
import type { HarnessConfig } from "../../src/config/types.js";

function baseConfig(
  overrides?: Partial<HarnessConfig["workflow"]>,
): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "app",
        targetRepo: "https://github.com/example/app",
        baseBranch: "dev",
        productionBranch: "main",
      },
    ],
    workflow: {
      schemaVersion: "product-development-v2",
      optionalPhases: { planReview: false, codeReview: false },
      cycleLimits: { planReview: 4, codeReview: 4 },
      ...overrides,
    },
  } as HarnessConfig;
}

const readyStatuses = [
  { name: "Code Review", type: "started" },
  { name: "Code Revision", type: "started" },
];

const syncOverrides = {
  promptImplemented: true,
  revisionPromptImplemented: true,
  skillPresent: true,
  modelConfigValid: true,
  reviserModelConfigValid: true,
  runnerSupportedSchemaVersions: ["product-development-v2"] as const,
};

describe("code review readiness — requested / configured / execution", () => {
  it("disabled when not requested", () => {
    const result = evaluateCodeReviewReadinessSync({
      config: baseConfig(),
      linearStatuses: readyStatuses,
      ...syncOverrides,
    });
    expect(result.requestedEnabled).toBe(false);
    expect(result.configuredReady).toBe(false);
    expect(result.uiState).toBe("disabled");
  });

  it("setup required when statuses missing", () => {
    const result = evaluateCodeReviewReadinessSync({
      config: baseConfig({
        optionalPhases: { planReview: false, codeReview: true },
      }),
      linearStatuses: [],
      ...syncOverrides,
    });
    expect(result.requestedEnabled).toBe(true);
    expect(result.configuredReady).toBe(false);
    expect(result.uiState).toBe("setup_required");
    expect(result.missingRequirements).toContain("missing_linear_status");
  });

  it("setup required when Code Revision status missing", () => {
    const result = evaluateCodeReviewReadinessSync({
      config: baseConfig({
        optionalPhases: { planReview: false, codeReview: true },
      }),
      linearStatuses: [{ name: "Code Review", type: "started" }],
      ...syncOverrides,
    });
    expect(result.configuredReady).toBe(false);
    expect(result.uiState).toBe("setup_required");
  });

  it("fully configured with no active issue displays Active", () => {
    const result = evaluateCodeReviewReadinessSync({
      config: baseConfig({
        optionalPhases: { planReview: false, codeReview: true },
      }),
      linearStatuses: readyStatuses,
      ...syncOverrides,
    });
    expect(result.requestedEnabled).toBe(true);
    expect(result.configuredReady).toBe(true);
    expect(result.effectiveEnabled).toBe(true);
    expect(result.uiState).toBe("active");
  });

  it("freeze captures configuredReady; readiness changes do not alter freeze", () => {
    const readiness = evaluateCodeReviewReadinessSync({
      config: baseConfig({
        optionalPhases: { planReview: false, codeReview: true },
      }),
      linearStatuses: [],
      ...syncOverrides,
    });
    const freeze = buildCodeReviewPhaseExecutionFreeze({
      readiness,
      codeReviewerModelId: "composer-2.5",
      codeReviewerFast: false,
    });
    expect(freeze.configuredReady).toBe(false);
    expect(freeze.effectiveEnabled).toBe(false);

    const later = evaluateCodeReviewReadinessSync({
      config: baseConfig({
        optionalPhases: { planReview: false, codeReview: true },
      }),
      linearStatuses: readyStatuses,
      ...syncOverrides,
    });
    expect(later.configuredReady).toBe(true);
    expect(freeze.configuredReady).toBe(false);
  });

  it("routes handoff to Code Review only when configuredReady", () => {
    const definition = resolveDefinitionWithCodeReviewReadiness({
      config: baseConfig({
        optionalPhases: { planReview: false, codeReview: true },
      }),
      readiness: { configuredReady: true },
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "handoff",
      cycleCounters: { plan_review_cycles: 0, code_review_cycles: 0 },
      evidence: { linearStatusName: "PR Open", prUrl: "https://github.com/x/y/pull/1" },
      outcome: {
        kind: "success",
        phaseId: "handoff",
        attemptIdentity: "handoff-1",
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.nextStatusName).toBe("Code Review");
  });

  it("bypasses to PM Review when not configuredReady", () => {
    const definition = resolveDefinitionWithCodeReviewReadiness({
      config: baseConfig({
        optionalPhases: { planReview: false, codeReview: true },
      }),
      readiness: { configuredReady: false },
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "handoff",
      cycleCounters: { plan_review_cycles: 0, code_review_cycles: 0 },
      evidence: { linearStatusName: "PR Open" },
      outcome: {
        kind: "success",
        phaseId: "handoff",
        attemptIdentity: "handoff-bypass",
      },
    });
    expect(result.nextStatusName).toBe("PM Review");
    expect(result.bypass?.createTrace).toBe(false);
  });
});

describe("code review execution eligibility", () => {
  const artifact = createImplementationArtifactIdentity({
    targetRepository: "https://github.com/example/app",
    prNumber: 42,
    prUrl: "https://github.com/example/app/pull/42",
    headSha: "abc123",
    baseSha: "def456",
    builderRunId: "build-1",
    workflowStateRevision: 3,
    implementationGenerationId: "impl-gen-1",
    diffHash: "diff-hash-1",
  });

  it("missing PR blocks issue recoverably (not executionEligible)", () => {
    const eligibility = evaluateCodeReviewExecutionEligibility({
      latestImplementation: null,
    });
    expect(eligibility.executionEligible).toBe(false);
    expect(eligibility.failureCodes).toContain("missing_pr_artifact");
  });

  it("matching live evidence is executionEligible", () => {
    const eligibility = evaluateCodeReviewExecutionEligibility({
      latestImplementation: artifact,
      liveEvidence: {
        prNumber: 42,
        repository: "https://github.com/example/app",
        headSha: "abc123",
        baseSha: "def456",
        diffHash: "diff-hash-1",
      },
    });
    expect(eligibility.executionEligible).toBe(true);
  });

  it("stale or mismatched PR remains ineligible", () => {
    const eligibility = evaluateCodeReviewExecutionEligibility({
      latestImplementation: artifact,
      liveEvidence: {
        prNumber: 42,
        repository: "https://github.com/example/app",
        headSha: "stale-head",
        baseSha: "def456",
        diffHash: "diff-hash-1",
      },
    });
    expect(eligibility.executionEligible).toBe(false);
    expect(eligibility.failureCodes).toContain("stale_implementation_generation");
  });

  it("PR appearing later allows eligibility to succeed", () => {
    const before = evaluateCodeReviewExecutionEligibility({
      latestImplementation: null,
    });
    expect(before.executionEligible).toBe(false);
    const after = evaluateCodeReviewExecutionEligibility({
      latestImplementation: artifact,
      liveEvidence: {
        prNumber: 42,
        repository: "https://github.com/example/app",
        headSha: "abc123",
        baseSha: "def456",
        diffHash: "diff-hash-1",
      },
    });
    expect(after.executionEligible).toBe(true);
  });

  it("telemetry separates configuration readiness from execution eligibility", () => {
    const readiness = evaluateCodeReviewReadinessSync({
      config: baseConfig({
        optionalPhases: { planReview: false, codeReview: true },
      }),
      linearStatuses: readyStatuses,
      ...syncOverrides,
    });
    const eligibility = evaluateCodeReviewExecutionEligibility({
      latestImplementation: null,
    });
    const readyDiag = buildCodeReviewReadinessDiagnostic({ readiness });
    const eligDiag = buildCodeReviewExecutionEligibilityDiagnostic({
      eligibility,
    });
    expect(readyDiag.event).toBe("p_dev_code_review_readiness");
    expect(readyDiag.properties.configured_ready).toBe(true);
    expect(readyDiag.properties).not.toHaveProperty("execution_eligible");
    expect(eligDiag.event).toBe("p_dev_code_review_execution_eligibility");
    expect(eligDiag.properties.execution_eligible).toBe(false);
    expect(eligDiag.properties).not.toHaveProperty("configured_ready");
  });
});
