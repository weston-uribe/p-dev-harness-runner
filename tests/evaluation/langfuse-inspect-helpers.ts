import { PRICING_REGISTRY_VERSION } from "../../src/evaluation/telemetry/pricing-registry.js";

export function completeGeneration(params: {
  id: string;
  name: string;
  phase: string;
  issueKey: string;
  phaseExecutionId?: string;
}): Record<string, unknown> {
  return {
    id: params.id,
    name: params.name,
    type: "GENERATION",
    model: "composer-2.5",
    usageDetails: { input: 10, output: 5 },
    metadata: {
      linearIssueKey: params.issueKey,
      phase: params.phase,
      phaseExecutionId: params.phaseExecutionId ?? `pe-${params.phase}`,
      harnessRunId: `run-${params.phase}`,
      effectiveVariant: "standard",
      costSource: "pricing_registry",
      estimatedCostUsd: 0.0000175,
      pricingRegistryVersion: PRICING_REGISTRY_VERSION,
    },
    costDetails: { total: 0.0000175 },
  };
}

export function planningAndPlanReviewTraces(issueKey: string): Array<
  Record<string, unknown>
> {
  return [
    {
      id: "plan",
      name: `${issueKey} · planning`,
      metadata: {
        linearIssueKey: issueKey,
        phase: "planning",
        harnessRunId: "run-planning",
        phaseExecutionId: "pe-planning",
      },
      observations: [
        {
          id: "planner",
          name: `${issueKey} · planner`,
          type: "AGENT",
          metadata: {
            linearIssueKey: issueKey,
            phase: "planning",
            phaseExecutionId: "pe-planning",
          },
        },
        completeGeneration({
          id: "gen-plan",
          name: `${issueKey} · planner · Cursor run`,
          phase: "planning",
          issueKey,
          phaseExecutionId: "pe-planning",
        }),
      ],
    },
    {
      id: "review",
      name: `${issueKey} · plan_review`,
      metadata: {
        linearIssueKey: issueKey,
        phase: "plan_review",
        harnessRunId: "run-plan-review",
        phaseExecutionId: "pe-plan-review",
      },
      observations: [
        {
          id: "reviewer",
          name: `${issueKey} · plan_reviewer`,
          type: "AGENT",
          metadata: {
            linearIssueKey: issueKey,
            phase: "plan_review",
            phaseExecutionId: "pe-plan-review",
          },
        },
        completeGeneration({
          id: "gen-review",
          name: `${issueKey} · plan_reviewer · Cursor run`,
          phase: "plan_review",
          issueKey,
          phaseExecutionId: "pe-plan-review",
        }),
      ],
    },
  ];
}
