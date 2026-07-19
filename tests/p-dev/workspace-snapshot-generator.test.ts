import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateWorkspaceSnapshot } from "../../src/p-dev/workspace-snapshot-generator.js";
import { resolveGitCommit } from "../../src/p-dev/workspace-snapshot-git.js";
import { parseWorkspaceSnapshotManifestJson } from "../../src/p-dev/workspace-snapshot-manifest.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("workspace snapshot generator", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it(
    "generates a deterministic manifest from the current git commit",
    async () => {
      const outputDir = await mkdtemp(path.join(os.tmpdir(), "p-dev-snapshot-"));
      tempDirs.push(outputDir);

      const sourceCommit = await resolveGitCommit(repoRoot, "HEAD");

      const first = await generateWorkspaceSnapshot({
        repoRoot,
        packageVersion: "0.3.0",
        sourceRef: sourceCommit,
        outputDir,
      });

      const manifestRaw = await readFile(path.join(outputDir, "manifest.json"), "utf8");
      const parsed = parseWorkspaceSnapshotManifestJson(manifestRaw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.manifest.snapshotContentId).toBe(first.manifest.snapshotContentId);
        expect(parsed.manifest.fileCount).toBeGreaterThan(100);
        expect(parsed.manifest.snapshotSha256).toBe(first.manifest.snapshotSha256);
      }
    },
    300_000,
  );

  it(
    "rejects tampered snapshot file bytes",
    async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "p-dev-snapshot-"));
    tempDirs.push(outputDir);

    const sourceCommit = await resolveGitCommit(repoRoot, "HEAD");
    const snapshot = await generateWorkspaceSnapshot({
      repoRoot,
      packageVersion: "0.3.0",
      sourceRef: sourceCommit,
      outputDir,
    });
    const target = snapshot.entries[0];
    expect(target).toBeDefined();
    const filePath = path.join(outputDir, "files", target!.path);
    await readFile(filePath);
    const { loadWorkspaceSnapshotEntryContent } = await import(
      "../../src/p-dev/workspace-snapshot-generator.js"
    );
    await expect(
      loadWorkspaceSnapshotEntryContent({
        snapshotRoot: outputDir,
        path: target!.path,
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/integrity check/);
    },
    300_000,
  );
});
