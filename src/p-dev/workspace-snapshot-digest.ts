import { createHash } from "node:crypto";
import type { WorkspaceSnapshotManifestFile } from "./workspace-snapshot-types.js";
import {
  compareUtf8Paths,
  computeSnapshotRootTreeSha1,
} from "./git-object-plumbing.js";

export { computeSnapshotRootTreeSha1 };

export function computeSnapshotFileSha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sortSnapshotManifestFiles(
  files: WorkspaceSnapshotManifestFile[],
): WorkspaceSnapshotManifestFile[] {
  return [...files].sort((left, right) => compareUtf8Paths(left.path, right.path));
}

export function computeSnapshotSha256(
  files: WorkspaceSnapshotManifestFile[],
): string {
  const sorted = sortSnapshotManifestFiles(files);
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.mode);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function computeSnapshotContentId(input: {
  packageVersion: string;
  sourceCommit: string;
  snapshotSha256: string;
}): string {
  return createHash("sha256")
    .update(input.packageVersion)
    .update("\0")
    .update(input.sourceCommit)
    .update("\0")
    .update(input.snapshotSha256)
    .digest("hex");
}
