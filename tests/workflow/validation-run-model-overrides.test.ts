import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import { applyValidationRunModelSelections } from "../../src/workflow/validation-run/model-overrides.js";
import type { ValidationRunSnapshot } from "../../src/workflow/validation-run/types.js";
import { resolveModelSelectionForRole } from "../../src/models/index.js";

function baseConfig(): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    defaultModel: { id: "composer-2.5" },
    repos: [],
    workflow: {
      schemaVersion: "product-development-v2",
      optionalPhases: { planReview: false, codeReview: false },
    },
  } as HarnessConfig;
}

function snapshot(
  modelSelections: ValidationRunSnapshot["modelSelections"],
): ValidationRunSnapshot {
  return {
    kind: "p-dev.validation-run-snapshot.v1",
    validationRunId: "vr-fast",
    state: "active",
    linearTeamId: "team",
    linearProjectId: "project",
    allowedIssueIds: ["TT-6"],
    requestedOptionalPhases: { planReview: false, codeReview: true },
    effectiveReadiness: {
      planReviewEffectiveEnabled: false,
      codeReviewConfiguredReady: true,
      missingRequirementCodes: [],
      evaluatedAt: "2026-07-19T00:00:00.000Z",
    },
    modelSelections,
    fastParameters: {
      planReviewer: null,
      codeReviewer: true,
      codeReviser: null,
    },
    cycleLimits: { planReview: 4, codeReview: 4 },
    prompt: { provider: "local" },
    workflowSchemaVersion: "product-development-v2",
    createdAt: "2026-07-19T00:00:00.000Z",
    expiresAt: null,
    completedAt: null,
  };
}

describe("applyValidationRunModelSelections", () => {
  it("pins Fast for codeReviewer from validation-run override only", () => {
    const config = baseConfig();
    const effective = applyValidationRunModelSelections(
      config,
      snapshot({
        codeReviewer: {
          id: "composer-2.5",
          params: [{ id: "fast", value: "true" }],
        },
      }),
    );
    expect(config.roleModels).toBeUndefined();
    const resolved = resolveModelSelectionForRole(effective, "codeReviewer");
    expect(resolved.resolution.effectiveVariant).toBe("fast");
    expect(resolved.params?.find((p) => p.id === "fast")?.value).toBe("true");
  });

  it("leaves config unchanged when snapshot has no modelSelections", () => {
    const config = baseConfig();
    const effective = applyValidationRunModelSelections(config, snapshot({}));
    expect(effective).toBe(config);
  });
});
