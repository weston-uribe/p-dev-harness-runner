import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RuntimeProvenanceConflictError,
  captureRuntimeProvenanceAtRunStart,
  ensureRuntimeProvenanceArtifact,
  parseManagedMarkerSourceCommit,
  readRuntimeProvenance,
} from "../../src/evaluation/runtime-provenance.js";
import { getRuntimeProvenancePath } from "../../src/artifacts/paths.js";

describe("runtime provenance", () => {
  it("parses managed marker source commit", () => {
    const commit = "a".repeat(40);
    const raw = JSON.stringify({
      createdFromPackageSnapshot: { sourceCommit: commit },
    });
    expect(parseManagedMarkerSourceCommit(raw)).toBe(commit);
    expect(parseManagedMarkerSourceCommit("{}")).toBeNull();
  });

  it("writes immutable runtime-provenance.json at run start", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-prov-"));
    const runDirectory = path.join(root, "WES-1", "run-1");
    await mkdir(runDirectory, { recursive: true });

    const previousHarness = process.env.HARNESS_SOURCE_COMMIT;
    const previousManaged = process.env.MANAGED_RUNNER_COMMIT;
    process.env.HARNESS_SOURCE_COMMIT = "c".repeat(40);
    process.env.MANAGED_RUNNER_COMMIT = "d".repeat(40);
    delete process.env.GITHUB_ACTIONS;

    try {
      await captureRuntimeProvenanceAtRunStart(runDirectory);
      const artifact = await readRuntimeProvenance(runDirectory);
      expect(artifact?.harnessSourceCommit).toBe("c".repeat(40));
      expect(artifact?.managedRunnerCommit).toBe("d".repeat(40));
      expect(artifact?.provenanceSchemaVersion).toBe("runtime-provenance-v1");

      await expect(
        ensureRuntimeProvenanceArtifact(runDirectory, {
          harnessSourceCommit: "e".repeat(40),
          managedRunnerCommit: "d".repeat(40),
          provenanceSchemaVersion: "runtime-provenance-v1",
          capturedAt: "2026-07-18T00:00:00.000Z",
          provenanceSource: "local_environment",
        }),
      ).rejects.toBeInstanceOf(RuntimeProvenanceConflictError);
    } finally {
      if (previousHarness === undefined) {
        delete process.env.HARNESS_SOURCE_COMMIT;
      } else {
        process.env.HARNESS_SOURCE_COMMIT = previousHarness;
      }
      if (previousManaged === undefined) {
        delete process.env.MANAGED_RUNNER_COMMIT;
      } else {
        process.env.MANAGED_RUNNER_COMMIT = previousManaged;
      }
    }

    const raw = await readFile(getRuntimeProvenancePath(runDirectory), "utf8");
    expect(raw).toContain("runtime-provenance-v1");
  });
});
