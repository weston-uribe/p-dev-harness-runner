import type { HarnessConfig } from "../config/types.js";
import { migrateWorkflowConfigSection } from "../config/migrate-workflow-config.js";
import { buildConfigFingerprint } from "./bootstrap.js";

export interface FixtureOptionalPhasesState {
  planReviewEnabled: boolean;
  planReviewCycleLimit: number;
  codeReviewEnabled: boolean;
  codeReviewCycleLimit: number;
}

const fixtureOptionalPhases = new Map<string, FixtureOptionalPhasesState>();

function storageKey(fixtureId: string, scopeId: string): string {
  return `${fixtureId}::${scopeId}`;
}

export function getFixtureOptionalPhases(
  fixtureId: string,
  scopeId: string,
  baseConfig: HarnessConfig,
): FixtureOptionalPhasesState {
  const stored = fixtureOptionalPhases.get(storageKey(fixtureId, scopeId));
  if (stored) {
    return stored;
  }
  const workflow = migrateWorkflowConfigSection(baseConfig);
  return {
    planReviewEnabled: workflow.optionalPhases.planReview,
    planReviewCycleLimit: workflow.cycleLimits.planReview,
    codeReviewEnabled: workflow.optionalPhases.codeReview,
    codeReviewCycleLimit: workflow.cycleLimits.codeReview,
  };
}

export function applyFixtureOptionalPhasesToConfig(input: {
  fixtureId: string;
  scopeId: string;
  baseConfig: HarnessConfig;
}): HarnessConfig {
  const state = getFixtureOptionalPhases(
    input.fixtureId,
    input.scopeId,
    input.baseConfig,
  );
  const workflow = migrateWorkflowConfigSection(input.baseConfig);
  return {
    ...input.baseConfig,
    workflow: {
      ...workflow,
      optionalPhases: {
        ...workflow.optionalPhases,
        planReview: state.planReviewEnabled,
        codeReview: state.codeReviewEnabled,
      },
      cycleLimits: {
        ...workflow.cycleLimits,
        planReview: state.planReviewCycleLimit,
        codeReview: state.codeReviewCycleLimit,
      },
    },
  };
}

export function saveFixtureOptionalPhases(input: {
  fixtureId: string;
  scopeId: string;
  baseConfig: HarnessConfig;
  planReviewEnabled: boolean;
  planReviewCycleLimit: number;
  codeReviewEnabled: boolean;
  codeReviewCycleLimit: number;
}): { configFingerprint: string } {
  const key = storageKey(input.fixtureId, input.scopeId);
  fixtureOptionalPhases.set(key, {
    planReviewEnabled: input.planReviewEnabled,
    planReviewCycleLimit: input.planReviewCycleLimit,
    codeReviewEnabled: input.codeReviewEnabled,
    codeReviewCycleLimit: input.codeReviewCycleLimit,
  });
  const merged = applyFixtureOptionalPhasesToConfig({
    fixtureId: input.fixtureId,
    scopeId: input.scopeId,
    baseConfig: input.baseConfig,
  });
  return { configFingerprint: buildConfigFingerprint(merged) };
}

export function resetFixtureOptionalPhasesForTests(): void {
  fixtureOptionalPhases.clear();
}
