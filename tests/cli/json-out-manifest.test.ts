import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { emptyMergeManifestFields } from "../../src/artifacts/manifest-fields.js";
import { runRunCommand } from "../../src/cli/commands/run.js";
import type { RunManifest } from "../../src/types/run.js";

const manifest: RunManifest = {
  runId: "2026-07-17T20-00-00Z-WES-1",
  issueKey: "WES-1",
  phase: "planning",
  phaseInferredFromStatus: "Ready for Planning",
  linearStatusBefore: "Ready for Planning",
  linearStatusAfter: "Planning",
  targetRepo: "https://github.com/o/r",
  baseBranch: "main",
  resolutionSource: "explicit",
  dryRun: false,
  finalOutcome: "success",
  errorClassification: null,
  startedAt: "2026-07-17T20:00:00.000Z",
  finishedAt: "2026-07-17T20:01:00.000Z",
  milestone: "m8",
  promptVersion: "planning@1",
  cursorAgentId: null,
  cursorRunId: null,
  branch: null,
  prUrl: null,
  previewUrl: null,
  validationSummary: null,
  changedFiles: null,
  checkSummary: null,
  previousImplementationRunId: null,
  previousHandoffRunId: null,
  pmFeedbackCommentId: null,
  ...emptyMergeManifestFields(),
  model: null,
};

vi.mock("../../src/runner/orchestrator.js", () => ({
  runOrchestrator: vi.fn(async () => ({
    exitCode: 0,
    runDirectory: "runs/WES-1/test",
    manifest,
  })),
}));

describe("run command json-out", () => {
  it("writes valid redacted JSON to json-out without mixing logs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "json-out-"));
    const jsonOutPath = path.join(dir, "harness-run-output.json");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runRunCommand({
      issueKey: "WES-1",
      configPath: "harness.config.json",
      jsonOut: jsonOutPath,
    });

    expect(exitCode).toBe(0);
    const raw = await readFile(jsonOutPath, "utf8");
    const parsed = JSON.parse(raw) as RunManifest;
    expect(parsed.finalOutcome).toBe("success");
    expect(raw).not.toContain("Run directory:");
    expect(logSpy).toHaveBeenCalledWith("Run finished: success");

    logSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes fallback manifest when orchestrator returns no manifest", async () => {
    const orchestrator = await import("../../src/runner/orchestrator.js");
    vi.mocked(orchestrator.runOrchestrator).mockResolvedValueOnce({
      exitCode: 1,
      manifest: undefined,
    });

    const dir = await mkdtemp(path.join(tmpdir(), "json-out-fallback-"));
    const jsonOutPath = path.join(dir, "harness-run-output.json");

    await runRunCommand({
      issueKey: "WES-2",
      configPath: "harness.config.json",
      jsonOut: jsonOutPath,
    });

    const raw = await readFile(jsonOutPath, "utf8");
    const parsed = JSON.parse(raw) as RunManifest;
    expect(parsed.finalOutcome).toBe("failed");
    expect(parsed.errorClassification).toBe("run_crash");
    expect(parsed.issueKey).toBe("WES-2");

    await rm(dir, { recursive: true, force: true });
  });
});
