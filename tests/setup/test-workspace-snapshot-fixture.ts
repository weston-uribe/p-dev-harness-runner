import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { P_DEV_PACKAGE_NAME } from "../../src/p-dev/package-paths.js";
import { computeSnapshotFileSha256 } from "../../src/p-dev/workspace-snapshot-digest.js";
import { computeGitBlobSha1 } from "../../src/p-dev/workspace-snapshot-git.js";
import {
  buildWorkspaceSnapshotManifest,
  fingerprintWorkspaceSnapshotManifest,
} from "../../src/p-dev/workspace-snapshot-manifest.js";
import {
  WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY,
  type WorkspaceSnapshotManifest,
} from "../../src/p-dev/workspace-snapshot-types.js";

export const TEST_SNAPSHOT_SOURCE_COMMIT =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const TEST_SNAPSHOT_README_PATH = "README.md";
export const TEST_SNAPSHOT_README_CONTENT = Buffer.from(
  "# p-dev harness workspace\n",
  "utf8",
);

export function buildTestWorkspaceSnapshotManifest(
  packageVersion = "0.3.0",
): WorkspaceSnapshotManifest {
  const gitBlobSha1 = computeGitBlobSha1(TEST_SNAPSHOT_README_CONTENT);
  return buildWorkspaceSnapshotManifest({
    packageVersion,
    sourceCommit: TEST_SNAPSHOT_SOURCE_COMMIT,
    entries: [
      {
        path: TEST_SNAPSHOT_README_PATH,
        type: "file",
        mode: "100644",
        size: TEST_SNAPSHOT_README_CONTENT.byteLength,
        content: TEST_SNAPSHOT_README_CONTENT,
        gitBlobSha1,
      },
    ],
  });
}

export async function createTestWorkspaceSnapshotRoot(
  packageVersion = "0.3.0",
): Promise<{
  snapshotRoot: string;
  manifest: WorkspaceSnapshotManifest;
  fingerprint: string;
  packageRoot: string;
}> {
  const packageRoot = await mkdtemp(path.join(tmpdir(), "p-dev-package-root-"));
  const snapshotRoot = path.join(packageRoot, "workspace-snapshot");
  const manifest = buildTestWorkspaceSnapshotManifest(packageVersion);
  await mkdir(path.join(snapshotRoot, "files"), { recursive: true });
  await writeFile(path.join(snapshotRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(snapshotRoot, "files", TEST_SNAPSHOT_README_PATH),
    TEST_SNAPSHOT_README_CONTENT,
  );
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: P_DEV_PACKAGE_NAME, version: packageVersion }, null, 2)}\n`,
    "utf8",
  );
  return {
    snapshotRoot,
    manifest,
    fingerprint: fingerprintWorkspaceSnapshotManifest(manifest),
    packageRoot,
  };
}

export function buildTestSnapshotPendingState(
  manifest: WorkspaceSnapshotManifest,
  overrides: Record<string, unknown> = {},
) {
  return {
    operationId: "op-pending",
    authenticatedUserId: 1,
    authenticatedLogin: "test-user",
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    sourceRepository: WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY,
    sourceCommit: manifest.sourceCommit,
    manifestSchemaVersion: manifest.schemaVersion,
    snapshotContentId: manifest.snapshotContentId,
    snapshotSha256: manifest.snapshotSha256,
    snapshotGitTreeSha1: manifest.gitRootTreeSha1,
    targetOwner: "test-user",
    targetRepo: "p-dev-harness",
    previewFingerprint: "creation-fingerprint",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function snapshotFileSha256(content: Buffer): string {
  return computeSnapshotFileSha256(content);
}
