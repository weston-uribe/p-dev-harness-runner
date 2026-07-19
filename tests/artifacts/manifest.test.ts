import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeManifest, readManifest } from "../../src/artifacts/manifest.js";
import { emptyMergeManifestFields } from "../../src/artifacts/manifest-fields.js";
import type { RunManifest } from "../../src/types/run.js";

describe("manifest writer", () => {
  it("round-trips manifest with required M1 fields", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-manifest-"));
    const manifest: RunManifest = {
      runId: "2026-07-06T20-30-00Z-WES-11",
      issueKey: "WES-11",
      phase: "implementation",
      phaseInferredFromStatus: "Ready for Build",
      linearStatusBefore: "Ready for Planning",
      linearStatusAfter: "Ready for Planning",
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "main",
      resolutionSource: "explicit",
      dryRun: true,
      finalOutcome: "success",
      errorClassification: null,
      startedAt: "2026-07-06T20:30:00.000Z",
      finishedAt: "2026-07-06T20:30:01.000Z",
      milestone: "m1",
      promptVersion: null,
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

    await writeManifest(dir, manifest);
    const raw = await readFile(path.join(dir, "manifest.json"), "utf8");
    expect(raw).toContain('"milestone": "m1"');

    const loaded = await readManifest(dir);
    expect(loaded.runId).toBe(manifest.runId);
    expect(loaded.finalOutcome).toBe("success");

    await rm(dir, { recursive: true, force: true });
  });
});
