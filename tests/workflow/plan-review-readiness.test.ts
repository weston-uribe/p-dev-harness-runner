import { describe, expect, it } from "vitest";
import {
  buildPhaseExecutionFreeze,
  evaluatePlanReviewReadinessSync,
  resolveDefinitionWithPlanReviewReadiness,
} from "../../src/workflow/plan-review-readiness.js";
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
      cycleLimits: { planReview: 4, codeReview: 3 },
      ...overrides,
    },
  } as HarnessConfig;
}

const readyStatuses = [{ name: "Plan Review", type: "started" }];

describe("plan review readiness — fail-closed", () => {
  it.each([
    {
      name: "requested disabled → effective disabled",
      config: baseConfig(),
      linearStatuses: readyStatuses,
      expected: {
        requestedEnabled: false,
        effectiveEnabled: false,
        uiState: "disabled" as const,
      },
    },
    {
      name: "requested enabled + missing status → setup required",
      config: baseConfig({
        optionalPhases: { planReview: true, codeReview: false },
      }),
      linearStatuses: [],
      expected: {
        requestedEnabled: true,
        effectiveEnabled: false,
        uiState: "setup_required" as const,
      },
      missing: "missing_linear_status",
    },
    {
      name: "wrong Linear status category → effective disabled",
      config: baseConfig({
        optionalPhases: { planReview: true, codeReview: false },
      }),
      linearStatuses: [{ name: "Plan Review", type: "backlog" }],
      expected: {
        requestedEnabled: true,
        effectiveEnabled: false,
        uiState: "setup_required" as const,
      },
      missing: "wrong_linear_status_category",
    },
    {
      name: "all requirements satisfied → effective enabled",
      config: baseConfig({
        optionalPhases: { planReview: true, codeReview: false },
      }),
      linearStatuses: readyStatuses,
      expected: {
        requestedEnabled: true,
        effectiveEnabled: true,
        uiState: "active" as const,
      },
    },
  ])("$name", ({ config, linearStatuses, expected, missing }) => {
    const result = evaluatePlanReviewReadinessSync({
      config,
      linearStatuses,
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
      runnerSupportedSchemaVersions: ["product-development-v2"],
    });
    expect(result.requestedEnabled).toBe(expected.requestedEnabled);
    expect(result.effectiveEnabled).toBe(expected.effectiveEnabled);
    expect(result.uiState).toBe(expected.uiState);
    if (missing) {
      expect(result.missingRequirements).toContain(missing);
    }
  });

  it("missing status cannot strand an issue after planning (routes to Ready for Build)", () => {
    const config = baseConfig({
      optionalPhases: { planReview: true, codeReview: false },
    });
    const readiness = evaluatePlanReviewReadinessSync({
      config,
      linearStatuses: [],
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    expect(readiness.effectiveEnabled).toBe(false);
    const definition = resolveDefinitionWithPlanReviewReadiness({
      config,
      readiness,
    });
    const result = evaluateTransition({
      definition,
      currentPhaseId: "planning",
      cycleCounters: {},
      evidence: { linearStatusName: "Planning" },
      outcome: {
        kind: "success",
        phaseId: "planning",
        attemptIdentity: "plan-setup",
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.nextStatusName).toBe("Ready for Build");
    expect(result.bypass?.createAgentRun).toBe(false);
  });

  it("readiness changes do not alter an already claimed phase freeze", () => {
    const readiness = evaluatePlanReviewReadinessSync({
      config: baseConfig({
        optionalPhases: { planReview: true, codeReview: false },
      }),
      linearStatuses: [],
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    const freeze = buildPhaseExecutionFreeze({
      readiness,
      planReviewerModelId: "composer-2.5",
      planReviewerFast: false,
      claimedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(freeze.effectiveEnabled).toBe(false);
    expect(freeze.requestedEnabled).toBe(true);

    // Later promotion would only apply to subsequent claims — freeze stays false.
    const later = evaluatePlanReviewReadinessSync({
      config: baseConfig({
        optionalPhases: { planReview: true, codeReview: false },
      }),
      linearStatuses: readyStatuses,
      promptImplemented: true,
      skillPresent: true,
      modelConfigValid: true,
    });
    expect(later.effectiveEnabled).toBe(true);
    expect(freeze.effectiveEnabled).toBe(false);
  });

  it("final readiness promotion changes only subsequent phase claims", () => {
    const config = baseConfig({
      optionalPhases: { planReview: true, codeReview: false },
    });
    const before = resolveDefinitionWithPlanReviewReadiness({
      config,
      readiness: { effectiveEnabled: false },
    });
    const after = resolveDefinitionWithPlanReviewReadiness({
      config,
      readiness: { effectiveEnabled: true },
    });
    const beforeRoute = evaluateTransition({
      definition: before,
      currentPhaseId: "planning",
      cycleCounters: {},
      evidence: { linearStatusName: "Planning" },
      outcome: {
        kind: "success",
        phaseId: "planning",
        attemptIdentity: "a",
      },
    });
    const afterRoute = evaluateTransition({
      definition: after,
      currentPhaseId: "planning",
      cycleCounters: {},
      evidence: { linearStatusName: "Planning" },
      outcome: {
        kind: "success",
        phaseId: "planning",
        attemptIdentity: "b",
      },
    });
    expect(beforeRoute.nextStatusName).toBe("Ready for Build");
    expect(afterRoute.nextStatusName).toBe("Plan Review");
  });
});
