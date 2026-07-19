import {
  computeGitBlobSha1,
  computeSnapshotRootTreeSha1,
} from "./git-object-plumbing.js";
import {
  isForbiddenSnapshotPath,
  normalizeSnapshotPath,
} from "./workspace-snapshot-policy.js";
import {
  computeSnapshotContentId,
  computeSnapshotFileSha256,
  computeSnapshotSha256,
} from "./workspace-snapshot-digest.js";
import { loadWorkspaceSnapshotEntryContent } from "./workspace-snapshot-generator.js";
import type { WorkspaceSnapshotManifest, WorkspaceSnapshotManifestFile } from "./workspace-snapshot-types.js";

const ALLOWED_MODES = new Set(["100644", "100755", "120000"]);

export function validateSnapshotFileEntry(
  file: WorkspaceSnapshotManifestFile,
): { ok: true } | { ok: false; reason: string } {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeSnapshotPath(file.path);
  } catch {
    return { ok: false, reason: `Snapshot file path is not canonical: ${file.path}` };
  }
  if (normalizedPath !== file.path) {
    return {
      ok: false,
      reason: `Snapshot file path is not canonical: ${file.path}`,
    };
  }
  if (isForbiddenSnapshotPath(file.path)) {
    return { ok: false, reason: `Forbidden snapshot path: ${file.path}` };
  }
  if (!ALLOWED_MODES.has(file.mode)) {
    return { ok: false, reason: `Unsupported snapshot mode ${file.mode} for ${file.path}.` };
  }
  if (file.type === "file" && file.mode !== "100644" && file.mode !== "100755") {
    return {
      ok: false,
      reason: `Snapshot file ${file.path} has invalid file mode ${file.mode}.`,
    };
  }
  if (file.type === "symlink" && file.mode !== "120000") {
    return {
      ok: false,
      reason: `Snapshot symlink ${file.path} must use mode 120000.`,
    };
  }
  return { ok: true };
}

export async function validateEmbeddedSnapshotFiles(input: {
  snapshotRoot: string;
  manifest: WorkspaceSnapshotManifest;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const seenPaths = new Set<string>();
  for (const file of input.manifest.files) {
    const entryValidation = validateSnapshotFileEntry(file);
    if (!entryValidation.ok) {
      return entryValidation;
    }
    if (seenPaths.has(file.path)) {
      return { ok: false, reason: `Duplicate snapshot path: ${file.path}` };
    }
    seenPaths.add(file.path);

    let content: Buffer;
    try {
      content = await loadWorkspaceSnapshotEntryContent({
        snapshotRoot: input.snapshotRoot,
        path: file.path,
        expectedSha256: file.sha256,
      });
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof Error
            ? error.message
            : `Snapshot file ${file.path} failed integrity validation.`,
      };
    }
    if (content.byteLength !== file.size) {
      return {
        ok: false,
        reason: `Snapshot file ${file.path} size mismatch (expected ${file.size}, got ${content.byteLength}).`,
      };
    }
    const sha256 = computeSnapshotFileSha256(content);
    if (sha256 !== file.sha256) {
      return {
        ok: false,
        reason: `Snapshot file ${file.path} SHA-256 mismatch.`,
      };
    }
    const gitBlobSha1 = computeGitBlobSha1(content);
    if (gitBlobSha1 !== file.gitBlobSha1) {
      return {
        ok: false,
        reason: `Snapshot file ${file.path} git blob SHA mismatch.`,
      };
    }
  }

  const expectedRootTreeSha1 = computeSnapshotRootTreeSha1(input.manifest.files);
  if (expectedRootTreeSha1 !== input.manifest.gitRootTreeSha1) {
    return {
      ok: false,
      reason: "Embedded snapshot root tree SHA does not match manifest files.",
    };
  }

  const expectedSnapshotSha256 = computeSnapshotSha256(input.manifest.files);
  if (expectedSnapshotSha256 !== input.manifest.snapshotSha256) {
    return {
      ok: false,
      reason: "Embedded snapshot digest does not match manifest files.",
    };
  }

  const expectedContentId = computeSnapshotContentId({
    packageVersion: input.manifest.packageVersion,
    sourceCommit: input.manifest.sourceCommit,
    snapshotSha256: input.manifest.snapshotSha256,
  });
  if (expectedContentId !== input.manifest.snapshotContentId) {
    return {
      ok: false,
      reason: "Embedded snapshot content ID does not match manifest inputs.",
    };
  }

  return { ok: true };
}
