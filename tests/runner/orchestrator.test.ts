import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RunManifest } from "../../src/types/run.js";

const mocks = vi.hoisted(() => ({
  executePlanningPhase: vi.fn(),
  executeImplementationPhase: vi.fn(),
  executeHandoffPhase: vi.fn(),
}));

vi.mock("../../src/runner/phases/planning.js", () => ({
  executePlanningPhase: mocks.executePlanningPhase,
}));

vi.mock("../../src/runner/phases/implementation.js", () => ({
  executeImplementationPhase: mocks.executeImplementationPhase,
}));

vi.mock("../../src/runner/phases/handoff.js", () => ({
  executeHandoffPhase: mocks.executeHandoffPhase,
}));

import {
  runOrchestrator,
  shouldContinueToHandoffAfterImplementation,
  shouldContinueToImplementationAfterPlanning,
} from "../../src/runner/orchestrator.js";

function baseManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "run-1",
    issueKey: "WES-20",
    phase: "planning",
    phaseInferredFromStatus: "Ready for Planning",
    linearStatusBefore: "Ready for Planning",
    linearStatusAfter: "Ready for Build",
    targetRepo: "https://github.com/owner/example-target-app",
    baseBranch: "dev",
    resolutionSource: "linear_project",
    dryRun: false,
    finalOutcome: "success",
    errorClassification: null,
    startedAt: "2026-07-08T00:00:00.000Z",
    finishedAt: "2026-07-08T00:01:00.000Z",
    milestone: "v0.3-prep",
    promptVersion: "planning@1",
    cursorAgentId: "agent-1",
    cursorRunId: "run-1",
    branch: null,
    prUrl: null,
    previewUrl: null,
    validationSummary: null,
    changedFiles: null,
    checkSummary: null,
    previousImplementationRunId: null,
    previousHandoffRunId: null,
    pmFeedbackCommentId: null,
    model: "composer-2.5",
    ...overrides,
  };
}

describe("shouldContinueToImplementationAfterPlanning", () => {
  it("continues only after successful planning", () => {
    expect(
      shouldContinueToImplementationAfterPlanning(
        baseManifest({ finalOutcome: "success" }),
      ),
    ).toBe(true);
    expect(
      shouldContinueToImplementationAfterPlanning(
        baseManifest({ finalOutcome: "duplicate" }),
      ),
    ).toBe(false);
    expect(
      shouldContinueToImplementationAfterPlanning(
        baseManifest({ finalOutcome: "failed" }),
      ),
    ).toBe(false);
    expect(
      shouldContinueToImplementationAfterPlanning(
        baseManifest({ linearStatusAfter: "Canceled", finalOutcome: "success" }),
      ),
    ).toBe(false);
  });
});

describe("shouldContinueToHandoffAfterImplementation", () => {
  it("continues only after successful implementation", () => {
    expect(
      shouldContinueToHandoffAfterImplementation(
        baseManifest({ phase: "implementation", finalOutcome: "success" }),
      ),
    ).toBe(true);
    expect(
      shouldContinueToHandoffAfterImplementation(
        baseManifest({
          phase: "implementation",
          finalOutcome: "duplicate",
          errorClassification: "recovery_handoff",
          prUrl: "https://github.com/owner/example-target-app/pull/12",
        }),
      ),
    ).toBe(true);
    expect(
      shouldContinueToHandoffAfterImplementation(
        baseManifest({ phase: "planning", finalOutcome: "success" }),
      ),
    ).toBe(false);
    expect(
      shouldContinueToHandoffAfterImplementation(
        baseManifest({ phase: "implementation", finalOutcome: "failed" }),
      ),
    ).toBe(false);
  });
});

describe("runOrchestrator planning continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("chains implementation after successful planning", async () => {
    const planningManifest = baseManifest({ finalOutcome: "success" });
    const implementationManifest = baseManifest({
      phase: "implementation",
      finalOutcome: "success",
      linearStatusBefore: "Ready for Build",
      linearStatusAfter: "Building",
    });

    mocks.executePlanningPhase.mockResolvedValue({
      exitCode: 0,
      runDirectory: "runs/WES-20/planning",
      manifest: planningManifest,
    });
    mocks.executeImplementationPhase.mockResolvedValue({
      exitCode: 0,
      runDirectory: "runs/WES-20/implementation",
      manifest: implementationManifest,
    });
    mocks.executeHandoffPhase.mockResolvedValue({
      exitCode: 0,
      runDirectory: "runs/WES-20/handoff",
      manifest: baseManifest({
        phase: "handoff",
        finalOutcome: "success",
        linearStatusBefore: "PR Open",
        linearStatusAfter: "PM Review",
      }),
    });

    const result = await runOrchestrator({
      issueKey: "WES-20",
      configPath: "harness.config.json",
      phase: "planning",
    });

    expect(mocks.executePlanningPhase).toHaveBeenCalledOnce();
    expect(mocks.executeImplementationPhase).toHaveBeenCalledOnce();
    expect(mocks.executeHandoffPhase).toHaveBeenCalledOnce();
    expect(result.manifest).toEqual(
      baseManifest({
        phase: "handoff",
        finalOutcome: "success",
        linearStatusBefore: "PR Open",
        linearStatusAfter: "PM Review",
      }),
    );
    expect(result.exitCode).toBe(0);
  });

  it("chains handoff after implementation recovery skip with existing PR", async () => {
    const implementationManifest = baseManifest({
      phase: "implementation",
      finalOutcome: "duplicate",
      errorClassification: "recovery_handoff",
      linearStatusBefore: "Building",
      linearStatusAfter: "Building",
      prUrl: "https://github.com/owner/example-target-app/pull/12",
    });
    const handoffManifest = baseManifest({
      phase: "handoff",
      finalOutcome: "success",
      linearStatusBefore: "Building",
      linearStatusAfter: "PM Review",
      prUrl: "https://github.com/owner/example-target-app/pull/12",
    });

    mocks.executeImplementationPhase.mockResolvedValue({
      exitCode: 0,
      runDirectory: "runs/WES-22/implementation",
      manifest: implementationManifest,
    });
    mocks.executeHandoffPhase.mockResolvedValue({
      exitCode: 0,
      runDirectory: "runs/WES-22/handoff",
      manifest: handoffManifest,
    });

    const result = await runOrchestrator({
      issueKey: "WES-22",
      configPath: "harness.config.json",
      phase: "implementation",
    });

    expect(mocks.executeHandoffPhase).toHaveBeenCalledOnce();
    expect(result.manifest).toEqual(handoffManifest);
    expect(result.exitCode).toBe(0);
  });

  it("chains handoff after successful implementation phase", async () => {
    const implementationManifest = baseManifest({
      phase: "implementation",
      finalOutcome: "success",
      linearStatusBefore: "Ready for Build",
      linearStatusAfter: "PR Open",
      prUrl: "https://github.com/owner/example-target-app/pull/10",
    });
    const handoffManifest = baseManifest({
      phase: "handoff",
      finalOutcome: "success",
      linearStatusBefore: "PR Open",
      linearStatusAfter: "PM Review",
      prUrl: "https://github.com/owner/example-target-app/pull/10",
    });

    mocks.executeImplementationPhase.mockResolvedValue({
      exitCode: 0,
      runDirectory: "runs/WES-21/implementation",
      manifest: implementationManifest,
    });
    mocks.executeHandoffPhase.mockResolvedValue({
      exitCode: 0,
      runDirectory: "runs/WES-21/handoff",
      manifest: handoffManifest,
    });

    const result = await runOrchestrator({
      issueKey: "WES-21",
      configPath: "harness.config.json",
      phase: "implementation",
    });

    expect(mocks.executeHandoffPhase).toHaveBeenCalledOnce();
    expect(result.manifest).toEqual(handoffManifest);
    expect(result.exitCode).toBe(0);
  });

  it("does not chain handoff after failed implementation", async () => {
    mocks.executeImplementationPhase.mockResolvedValue({
      exitCode: 3,
      runDirectory: "runs/WES-21/implementation",
      manifest: baseManifest({
        phase: "implementation",
        finalOutcome: "failed",
      }),
    });

    const result = await runOrchestrator({
      issueKey: "WES-21",
      configPath: "harness.config.json",
      phase: "implementation",
    });

    expect(mocks.executeHandoffPhase).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(3);
  });

  it("does not chain implementation after duplicate planning skip", async () => {
    mocks.executePlanningPhase.mockResolvedValue({
      exitCode: 0,
      runDirectory: "runs/WES-20/planning",
      manifest: baseManifest({
        finalOutcome: "duplicate",
        errorClassification: "duplicate_phase_completed",
      }),
    });

    const result = await runOrchestrator({
      issueKey: "WES-20",
      configPath: "harness.config.json",
      phase: "planning",
    });

    expect(mocks.executePlanningPhase).toHaveBeenCalledOnce();
    expect(mocks.executeImplementationPhase).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it("does not chain implementation after failed planning", async () => {
    mocks.executePlanningPhase.mockResolvedValue({
      exitCode: 3,
      runDirectory: "runs/WES-20/planning",
      manifest: baseManifest({ finalOutcome: "failed" }),
    });

    const result = await runOrchestrator({
      issueKey: "WES-20",
      configPath: "harness.config.json",
      phase: "planning",
    });

    expect(mocks.executeImplementationPhase).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(3);
  });
});
