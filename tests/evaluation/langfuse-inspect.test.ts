import { describe, expect, it } from "vitest";
import {
  generationCostIncompleteReason,
  buildInspectReport,
} from "../../src/evaluation/langfuse-inspect/report.js";
import { deriveSessionId } from "../../src/evaluation/identifiers.js";
import { PRICING_REGISTRY_VERSION } from "../../src/evaluation/telemetry/pricing-registry.js";
import type { LangfuseInspectObservation } from "../../src/evaluation/langfuse-inspect/types.js";
import {
  OPTIONAL_REVIEW_RECONCILE_STATUSES,
  resolveWorkflowReconcileStatusNames,
} from "../../src/runner/workflow-reconcile.js";

describe("langfuse inspect report", () => {
  it("fails acceptance when planning trace and planner agent are missing", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: { id: sessionId },
      expectedPhases: ["planning"],
      traces: [
        {
          id: "t1",
          name: "p-dev.implementation",
          metadata: { phase: "implementation" },
          observations: [],
        },
      ],
      observations: [],
      scores: [],
    });
    expect(report.acceptance.hasPlanningTrace).toBe(false);
    expect(report.acceptance.hasPlannerAgent).toBe(false);
    expect(report.acceptance.coreComplete).toBe(false);
    expect(report.acceptance.complete).toBe(false);
    expect(report.gaps.some((g) => g.code === "missing_planning_trace")).toBe(
      true,
    );
    expect(
      report.gaps.some(
        (g) =>
          g.code === "missing_visible_issue_key" && g.severity === "warning",
      ),
    ).toBe(true);
  });

  it("passes planner gates when human-readable planning entities exist", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: { id: sessionId, name: "FRE-3" },
      expectedPhases: ["planning"],
      traces: [
        {
          id: "plan",
          name: "FRE-3 · planning",
          metadata: {
            linearIssueKey: "FRE-3",
            phase: "planning",
            harnessRunId: "run-plan",
            phaseExecutionId: "pe-plan",
          },
          observations: [
            {
              id: "planner",
              name: "FRE-3 · planner",
              type: "AGENT",
              metadata: { linearIssueKey: "FRE-3", phase: "planning" },
            },
            {
              id: "gen",
              name: "FRE-3 · planner · Cursor run",
              type: "GENERATION",
              model: "composer-2.5",
              usageDetails: { input: 10, output: 5 },
              metadata: {
                linearIssueKey: "FRE-3",
                effectiveVariant: "standard",
                costSource: "pricing_registry",
                estimatedCostUsd: 0.0000175,
                pricingRegistryVersion: PRICING_REGISTRY_VERSION,
              },
              costDetails: { total: 0.0000175 },
            },
          ],
        },
      ],
      observations: [],
      scores: [
        {
          id: "s1",
          name: "phase_success",
          traceId: "plan",
          value: true,
        },
      ],
    });
    expect(report.acceptance.hasPlanningTrace).toBe(true);
    expect(report.acceptance.hasPlannerAgent).toBe(true);
    expect(report.acceptance.missingVisibleIssueKey).toBe(false);
    expect(
      report.gaps.some((g) => g.code === "incomplete_cost_record"),
    ).toBe(false);
    expect(report.acceptance.generationCostComplete).toBe(true);
    expect(report.acceptance.coreComplete).toBe(true);
  });

  it("accepts provider-reported cost without requiring pricing registry version", () => {
    const obs: LangfuseInspectObservation = {
      id: "gen",
      name: "FRE-3 · planner · Cursor run",
      type: "GENERATION",
      startTime: null,
      endTime: null,
      model: "composer-2.5",
      hasInput: true,
      hasOutput: true,
      inputByteCount: 1,
      outputByteCount: 1,
      inputSha256: null,
      outputSha256: null,
      usage: { input: 10, output: 5 },
      costUsd: 0.02,
      costSource: "provider",
      costUnavailableReason: null,
      pricingRegistryVersion: null,
      promptName: null,
      promptContractVersion: null,
      skillIds: [],
      skillProvenanceStatus: null,
      toolCount: 0,
      agentId: null,
      cursorRunId: null,
      linearIssueKey: "FRE-3",
      phase: "planning",
      phaseExecutionId: null,
      harnessRunId: null,
      revisionCycleIndex: null,
      metadata: {
        providerReportedCostUsd: 0.02,
        effectiveVariant: "standard",
      },
    };
    expect(generationCostIncompleteReason(obs)).toBeNull();
  });

  it("flags incomplete cost when costSource=unavailable without estimate", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: null,
      expectedPhases: ["planning"],
      traces: [
        {
          id: "plan",
          name: "FRE-3 · planning",
          metadata: { linearIssueKey: "FRE-3", phase: "planning" },
          observations: [
            {
              id: "gen",
              name: "FRE-3 · planner · Cursor run",
              type: "GENERATION",
              model: "composer-2.5",
              usageDetails: { input: 10, output: 5 },
              metadata: {
                linearIssueKey: "FRE-3",
                effectiveVariant: "standard",
                costSource: "unavailable",
                costUnavailableReason: "missing_pricing_entry",
              },
            },
            {
              id: "planner",
              name: "FRE-3 · planner",
              type: "AGENT",
              metadata: { linearIssueKey: "FRE-3" },
            },
          ],
        },
      ],
      observations: [],
      scores: [],
    });
    expect(report.gaps.some((g) => g.code === "incomplete_cost_record")).toBe(
      true,
    );
  });

  it("flags dual authoritative provider and estimated costs", () => {
    const obs: LangfuseInspectObservation = {
      id: "gen",
      name: "FRE-3 · planner · Cursor run",
      type: "GENERATION",
      startTime: null,
      endTime: null,
      model: "composer-2.5",
      hasInput: true,
      hasOutput: true,
      inputByteCount: 1,
      outputByteCount: 1,
      inputSha256: null,
      outputSha256: null,
      usage: { input: 10, output: 5 },
      costUsd: 0.02,
      costSource: "provider",
      costUnavailableReason: null,
      pricingRegistryVersion: PRICING_REGISTRY_VERSION,
      promptName: null,
      promptContractVersion: null,
      skillIds: [],
      skillProvenanceStatus: null,
      toolCount: 0,
      agentId: null,
      cursorRunId: null,
      linearIssueKey: "FRE-3",
      phase: "planning",
      phaseExecutionId: null,
      harnessRunId: null,
      revisionCycleIndex: null,
      metadata: {
        providerReportedCostUsd: 0.02,
        estimatedCostUsd: 0.00001,
        effectiveVariant: "standard",
      },
    };
    expect(generationCostIncompleteReason(obs)).toBe(
      "dual_authoritative_cost_sources",
    );
  });

  it("flags fast variant priced with standard registry rates", () => {
    const obs: LangfuseInspectObservation = {
      id: "gen",
      name: "FRE-3 · planner · Cursor run",
      type: "GENERATION",
      startTime: null,
      endTime: null,
      model: "composer-2.5",
      hasInput: true,
      hasOutput: true,
      inputByteCount: 1,
      outputByteCount: 1,
      inputSha256: null,
      outputSha256: null,
      usage: { input: 1_000_000, output: 1_000_000 },
      costUsd: 3.0,
      costSource: "pricing_registry",
      costUnavailableReason: null,
      pricingRegistryVersion: PRICING_REGISTRY_VERSION,
      promptName: null,
      promptContractVersion: null,
      skillIds: [],
      skillProvenanceStatus: null,
      toolCount: 0,
      agentId: null,
      cursorRunId: null,
      linearIssueKey: "FRE-3",
      phase: "planning",
      phaseExecutionId: null,
      harnessRunId: null,
      revisionCycleIndex: null,
      metadata: {
        estimatedCostUsd: 3.0,
        effectiveVariant: "fast",
        modelParams: [{ id: "fast", value: "true" }],
      },
    };
    expect(generationCostIncompleteReason(obs)).toBe("variant_pricing_mismatch");
  });

  it("fails when reprojected observation claims skills without artifact evidence", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: { id: sessionId, name: "FRE-3" },
      expectedPhases: ["planning"],
      traces: [
        {
          id: "plan",
          name: "FRE-3 · planning",
          metadata: {
            linearIssueKey: "FRE-3",
            phase: "planning",
            harnessRunId: "run-plan",
          },
          observations: [
            {
              id: "planner",
              name: "FRE-3 · planner",
              type: "AGENT",
              metadata: {
                linearIssueKey: "FRE-3",
                reprojected: true,
                harnessRunId: "run-plan",
                skillsUsed: [{ skillId: "planner" }],
                skillProvenanceStatus: "present",
                inclusionMethod: "rendered_into_prompt",
              },
            },
            {
              id: "gen",
              name: "FRE-3 · planner · Cursor run",
              type: "GENERATION",
              model: "composer-2.5",
              usageDetails: { input: 10, output: 5 },
              metadata: {
                linearIssueKey: "FRE-3",
                reprojected: true,
                harnessRunId: "run-plan",
                effectiveVariant: "standard",
                costSource: "pricing_registry",
                estimatedCostUsd: 0.0000175,
                pricingRegistryVersion: PRICING_REGISTRY_VERSION,
                skillsUsed: [],
                skillProvenanceStatus: "none",
              },
            },
          ],
        },
      ],
      observations: [],
      scores: [],
      artifactRuns: [
        {
          runId: "run-plan",
          phase: "planning",
          sessionId,
          traceId: null,
          skillIds: [],
          skillProvenanceStatus: "none",
        },
      ],
    });
    expect(
      report.gaps.some((g) => g.code === "false_skill_provenance"),
    ).toBe(true);
    expect(report.acceptance.coreComplete).toBe(false);
  });

  it("accepts honest historical skillProvenanceStatus=none on reprojected observations", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: { id: sessionId, name: "FRE-3" },
      expectedPhases: ["planning"],
      traces: [
        {
          id: "plan",
          name: "FRE-3 · planning",
          metadata: {
            linearIssueKey: "FRE-3",
            phase: "planning",
            harnessRunId: "run-plan",
          },
          observations: [
            {
              id: "planner",
              name: "FRE-3 · planner",
              type: "AGENT",
              metadata: {
                linearIssueKey: "FRE-3",
                reprojected: true,
                harnessRunId: "run-plan",
                skillsUsed: [],
                skillProvenanceStatus: "none",
              },
            },
            {
              id: "gen",
              name: "FRE-3 · planner · Cursor run",
              type: "GENERATION",
              model: "composer-2.5",
              usageDetails: { input: 10, output: 5 },
              metadata: {
                linearIssueKey: "FRE-3",
                reprojected: true,
                harnessRunId: "run-plan",
                effectiveVariant: "standard",
                costSource: "pricing_registry",
                estimatedCostUsd: 0.0000175,
                pricingRegistryVersion: PRICING_REGISTRY_VERSION,
                skillsUsed: [],
                skillProvenanceStatus: "none",
              },
            },
          ],
        },
      ],
      observations: [],
      scores: [],
      artifactRuns: [
        {
          runId: "run-plan",
          phase: "planning",
          sessionId,
          traceId: null,
          skillIds: [],
          skillProvenanceStatus: "none",
        },
      ],
    });
    expect(
      report.gaps.some((g) => g.code === "false_skill_provenance"),
    ).toBe(false);
    expect(report.acceptance.coreComplete).toBe(true);
  });

  it("does not treat unnamed incomplete generations as cost-complete", () => {
    const sessionId = deriveSessionId("weston-dogfood", "FRE-3");
    const report = buildInspectReport({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      sessionId,
      session: { id: sessionId, name: "FRE-3" },
      expectedPhases: ["planning"],
      traces: [
        {
          id: "plan",
          name: "FRE-3 · planning",
          metadata: {
            linearIssueKey: "FRE-3",
            phase: "planning",
            phaseExecutionId: "pe-plan",
          },
          observations: [
            {
              id: "planner",
              name: "FRE-3 · planner",
              type: "AGENT",
              metadata: { linearIssueKey: "FRE-3", phase: "planning" },
            },
            {
              id: "unnamed-gen",
              name: null,
              type: "GENERATION",
              metadata: {
                linearIssueKey: "FRE-3",
                phase: "planning",
                phaseExecutionId: "pe-plan",
              },
            },
          ],
        },
      ],
      observations: [],
      scores: [],
    });
    expect(report.acceptance.generationCostComplete).toBe(false);
    expect(report.acceptance.requiredGenerationCount).toBeGreaterThan(0);
    expect(report.acceptance.incompleteRequiredGenerationCount).toBeGreaterThan(
      0,
    );
    expect(report.acceptance.coreComplete).toBe(false);
  });
});

describe("workflow reconcile status discovery", () => {
  it("includes dispatch and review statuses without hard-coded issue keys", () => {
    const statuses = resolveWorkflowReconcileStatusNames({
      repos: [],
      logDirectory: "runs",
      orchestratorMarker: "p-dev",
    });
    expect(statuses).toContain("Ready for Planning");
    expect(statuses).toContain("Ready for Build");
    expect(statuses).toContain("PR Open");
    for (const reviewStatus of OPTIONAL_REVIEW_RECONCILE_STATUSES) {
      expect(statuses).toContain(reviewStatus);
    }
    expect(statuses).toContain("Needs Revision");
    expect(statuses).toContain("Ready to Merge");
  });
});
