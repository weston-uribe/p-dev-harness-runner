import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeGitBlobSha1 } from "../../src/p-dev/git-object-plumbing.js";
import { buildWorkspaceSnapshotManifest } from "../../src/p-dev/workspace-snapshot-manifest.js";
import type { WorkspaceSnapshotManifest } from "../../src/p-dev/workspace-snapshot-types.js";

/**
 * Representative mid-size snapshot (not a 3-file toy fixture) for fast
 * recovery/timeout coverage. Full embedded 877-file snapshot is covered
 * separately in the hard-gate bulk transport test.
 */
export async function createRepresentativeBulkSnapshotFixture(
  fileCount = 64,
): Promise<{
  packageRoot: string;
  snapshotRoot: string;
  manifest: WorkspaceSnapshotManifest;
}> {
  const packageRoot = await mkdtemp(path.join(tmpdir(), "p-dev-bulk-fixture-"));
  const snapshotRoot = path.join(packageRoot, "workspace-snapshot");
  const filesDir = path.join(snapshotRoot, "files");
  await mkdir(filesDir, { recursive: true });

  const entries: Array<{
    path: string;
    type: "file";
    mode: "100644" | "100755";
    size: number;
    content: Buffer;
    gitBlobSha1: string;
  }> = [];

  for (let index = 0; index < fileCount; index += 1) {
    const relativePath =
      index % 7 === 0
        ? `bin/tool-${index}.sh`
        : index % 5 === 0
          ? `nested/dir-${index % 11}/file-${index}.txt`
          : `file-${index}.txt`;
    const mode = relativePath.endsWith(".sh") ? ("100755" as const) : ("100644" as const);
    const content = Buffer.from(
      relativePath.endsWith(".sh")
        ? `#!/bin/sh\necho "tool-${index}"\n`
        : `content-for-${relativePath}\n`,
      "utf8",
    );
    const absolute = path.join(filesDir, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, { mode: mode === "100755" ? 0o755 : 0o644 });
    entries.push({
      path: relativePath,
      type: "file",
      mode,
      size: content.byteLength,
      content,
      gitBlobSha1: computeGitBlobSha1(content),
    });
  }

  const manifest = buildWorkspaceSnapshotManifest({
    packageVersion: "0.3.1-debug",
    sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    entries,
  });
  await writeFile(
    path.join(snapshotRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { packageRoot, snapshotRoot, manifest };
}
