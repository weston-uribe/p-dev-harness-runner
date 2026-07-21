import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLangfuseReproject } from "../../src/evaluation/langfuse-reproject/run.js";

const fixtureCache = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/evaluation/fre3-artifact-cache",
);

describe("langfuse reproject dry-run", () => {
  it("loads FRE-3 cached artifacts and plans planning trace creation", async () => {
    const { report, exitCode } = await runLangfuseReproject({
      issueKey: "FRE-3",
      namespace: "weston-dogfood",
      artifactCache: fixtureCache,
      // Keep logDirectory off the live repo runs/ tree.
      logDirectory: path.join(fixtureCache, ".empty-runs"),
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
