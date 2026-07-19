import { describe, expect, it } from "vitest";
import path from "node:path";
import { runLangfuseReproject } from "../../src/evaluation/langfuse-reproject/run.js";

describe("langfuse reproject dry-run", () => {
  it("loads FRE-3 cached artifacts and plans planning trace creation", async () => {
    const cache = path.resolve("runs/.fre3-artifact-cache");
    const { report, exitCode } = await runLangfuseReproject({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      artifactCache: cache,
      dryRun: true,
      apply: false,
    });
    expect(exitCode).toBe(0);
    expect(report.mode).toBe("dry-run");
    expect(report.sourceArtifactHashes.length).toBeGreaterThan(0);
    expect(
      report.changes.some(
        (c) => c.name === "FRE-3 · planning" && c.action === "create_trace",
      ),
    ).toBe(true);
    expect(
      report.changes.some((c) => c.name === "FRE-3 · planner"),
    ).toBe(true);
  });
});
