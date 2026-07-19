import {
  WORKSPACE_SNAPSHOT_FORMAT,
  WORKSPACE_SNAPSHOT_FORMAT_VERSION,
  WORKSPACE_SNAPSHOT_PRODUCT,
  WORKSPACE_SNAPSHOT_ROLE,
  WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
  WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY,
  type WorkspaceSnapshotManifest,
  type WorkspaceSnapshotManifestFile,
} from "./workspace-snapshot-types.js";
import { P_DEV_PACKAGE_NAME } from "./package-paths.js";
import {
  isForbiddenSnapshotPath,
  normalizeSnapshotPath,
} from "./workspace-snapshot-policy.js";
import {
  computeSnapshotContentId,
  computeSnapshotFileSha256,
  computeSnapshotRootTreeSha1,
  computeSnapshotSha256,
  sortSnapshotManifestFiles,
} from "./workspace-snapshot-digest.js";
import type { GitCommitObjectEntry } from "./workspace-snapshot-git.js";

function parseGitObjectPack(
  value: unknown,
): WorkspaceSnapshotManifest["gitObjectPack"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Workspace snapshot gitObjectPack is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.packPath !== "string" ||
    typeof record.indexPath !== "string" ||
    !record.packPath.startsWith("object-pack/") ||
    !record.indexPath.startsWith("object-pack/") ||
    !record.packPath.endsWith(".pack") ||
    !record.indexPath.endsWith(".idx")
  ) {
    throw new Error("Workspace snapshot gitObjectPack paths are invalid.");
  }
  if (typeof record.packSha1 !== "string" || !/^[0-9a-f]{40}$/.test(record.packSha1)) {
    throw new Error("Workspace snapshot gitObjectPack is missing packSha1.");
  }
  if (typeof record.packSha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.packSha256)) {
    throw new Error("Workspace snapshot gitObjectPack is missing packSha256.");
  }
  if (typeof record.objectCount !== "number" || !Number.isFinite(record.objectCount)) {
    throw new Error("Workspace snapshot gitObjectPack is missing objectCount.");
  }
  if (typeof record.packSizeBytes !== "number" || !Number.isFinite(record.packSizeBytes)) {
    throw new Error("Workspace snapshot gitObjectPack is missing packSizeBytes.");
  }
  return {
    packPath: record.packPath,
    indexPath: record.indexPath,
    packSha1: record.packSha1,
    packSha256: record.packSha256,
    objectCount: record.objectCount,
    packSizeBytes: record.packSizeBytes,
  };
}

export function buildWorkspaceSnapshotManifestFiles(
  entries: GitCommitObjectEntry[],
): WorkspaceSnapshotManifestFile[] {
  return sortSnapshotManifestFiles(
    entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      sha256: computeSnapshotFileSha256(entry.content),
      gitBlobSha1: entry.gitBlobSha1,
    })),
  );
}

export function buildWorkspaceSnapshotManifest(input: {
  packageVersion: string;
  sourceCommit: string;
  entries: GitCommitObjectEntry[];
}): WorkspaceSnapshotManifest {
  const files = buildWorkspaceSnapshotManifestFiles(input.entries);
  const snapshotSha256 = computeSnapshotSha256(files);
  const snapshotContentId = computeSnapshotContentId({
    packageVersion: input.packageVersion,
    sourceCommit: input.sourceCommit,
    snapshotSha256,
  });
  const gitRootTreeSha1 = computeSnapshotRootTreeSha1(files);

  return {
    schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
    product: WORKSPACE_SNAPSHOT_PRODUCT,
    role: WORKSPACE_SNAPSHOT_ROLE,
    packageName: P_DEV_PACKAGE_NAME,
    packageVersion: input.packageVersion,
    sourceRepository: WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY,
    sourceCommit: input.sourceCommit,
    snapshotContentId,
    snapshotSha256,
    gitRootTreeSha1,
    fileCount: files.length,
    generation: {
      format: WORKSPACE_SNAPSHOT_FORMAT,
      version: WORKSPACE_SNAPSHOT_FORMAT_VERSION,
      pathOrdering: "utf8-bytes",
      digestAlgorithm: "sha256",
      modeSource: "git-ls-tree",
      byteSource: "git-cat-file",
    },
    files,
  };
}

export type WorkspaceSnapshotManifestValidationResult =
  | { ok: true; manifest: WorkspaceSnapshotManifest }
  | { ok: false; reason: string };

export function parseWorkspaceSnapshotManifestJson(
  raw: string,
): WorkspaceSnapshotManifestValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "Workspace snapshot manifest JSON is malformed." };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "Workspace snapshot manifest JSON is malformed." };
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== WORKSPACE_SNAPSHOT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `Unsupported workspace snapshot schema version ${String(record.schemaVersion)}.`,
    };
  }
  if (record.product !== WORKSPACE_SNAPSHOT_PRODUCT) {
    return {
      ok: false,
      reason: `Unexpected workspace snapshot product ${String(record.product)}.`,
    };
  }
  if (record.role !== WORKSPACE_SNAPSHOT_ROLE) {
    return {
      ok: false,
      reason: `Unexpected workspace snapshot role ${String(record.role)}.`,
    };
  }
  if (record.packageName !== P_DEV_PACKAGE_NAME) {
    return {
      ok: false,
      reason: `Unexpected workspace snapshot package name ${String(record.packageName)}.`,
    };
  }
  if (typeof record.packageVersion !== "string" || !record.packageVersion.trim()) {
    return {
      ok: false,
      reason: "Workspace snapshot manifest is missing packageVersion.",
    };
  }
  if (record.sourceRepository !== WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY) {
    return {
      ok: false,
      reason: `Unexpected workspace snapshot source repository ${String(record.sourceRepository)}.`,
    };
  }
  if (typeof record.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(record.sourceCommit)) {
    return {
      ok: false,
      reason: "Workspace snapshot manifest is missing a valid sourceCommit.",
    };
  }
  if (typeof record.snapshotContentId !== "string" || !/^[0-9a-f]{64}$/.test(record.snapshotContentId)) {
    return {
      ok: false,
      reason: "Workspace snapshot manifest is missing snapshotContentId.",
    };
  }
  if (typeof record.snapshotSha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.snapshotSha256)) {
    return {
      ok: false,
      reason: "Workspace snapshot manifest is missing snapshotSha256.",
    };
  }
  if (typeof record.gitRootTreeSha1 !== "string" || !/^[0-9a-f]{40}$/.test(record.gitRootTreeSha1)) {
    return {
      ok: false,
      reason: "Workspace snapshot manifest is missing gitRootTreeSha1.",
    };
  }
  if (typeof record.fileCount !== "number" || !Number.isFinite(record.fileCount)) {
    return {
      ok: false,
      reason: "Workspace snapshot manifest is missing fileCount.",
    };
  }
  if (!record.generation || typeof record.generation !== "object") {
    return { ok: false, reason: "Workspace snapshot manifest is missing generation metadata." };
  }
  const generation = record.generation as Record<string, unknown>;
  if (generation.format !== WORKSPACE_SNAPSHOT_FORMAT) {
    return {
      ok: false,
      reason: `Unsupported workspace snapshot generation format ${String(generation.format)}.`,
    };
  }
  if (generation.version !== WORKSPACE_SNAPSHOT_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `Unsupported workspace snapshot generation version ${String(generation.version)}.`,
    };
  }
  if (generation.pathOrdering !== "utf8-bytes") {
    return {
      ok: false,
      reason: `Unsupported workspace snapshot path ordering ${String(generation.pathOrdering)}.`,
    };
  }
  if (generation.digestAlgorithm !== "sha256") {
    return {
      ok: false,
      reason: `Unsupported workspace snapshot digest algorithm ${String(generation.digestAlgorithm)}.`,
    };
  }
  if (!Array.isArray(record.files)) {
    return { ok: false, reason: "Workspace snapshot manifest is missing files." };
  }

  const files: WorkspaceSnapshotManifestFile[] = [];
  const seenPaths = new Set<string>();
  for (const file of record.files) {
    if (!file || typeof file !== "object") {
      return { ok: false, reason: "Workspace snapshot manifest contains an invalid file entry." };
    }
    const fileRecord = file as Record<string, unknown>;
    if (typeof fileRecord.path !== "string" || !fileRecord.path.trim()) {
      return { ok: false, reason: "Workspace snapshot manifest contains a file without path." };
    }
    if (fileRecord.type !== "file" && fileRecord.type !== "symlink") {
      return { ok: false, reason: `Unsupported snapshot file type ${String(fileRecord.type)}.` };
    }
    if (typeof fileRecord.mode !== "string" || !fileRecord.mode.trim()) {
      return { ok: false, reason: `Snapshot file ${fileRecord.path} is missing mode.` };
    }
    if (typeof fileRecord.size !== "number" || !Number.isFinite(fileRecord.size)) {
      return { ok: false, reason: `Snapshot file ${fileRecord.path} is missing size.` };
    }
    if (typeof fileRecord.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(fileRecord.sha256)) {
      return { ok: false, reason: `Snapshot file ${fileRecord.path} is missing sha256.` };
    }
    if (typeof fileRecord.gitBlobSha1 !== "string" || !/^[0-9a-f]{40}$/.test(fileRecord.gitBlobSha1)) {
      return { ok: false, reason: `Snapshot file ${fileRecord.path} is missing gitBlobSha1.` };
    }
    let normalizedPath: string;
    try {
      normalizedPath = normalizeSnapshotPath(String(fileRecord.path));
    } catch {
      return { ok: false, reason: `Snapshot file path is not canonical: ${String(fileRecord.path)}` };
    }
    if (normalizedPath !== fileRecord.path) {
      return {
        ok: false,
        reason: `Snapshot file path is not canonical: ${String(fileRecord.path)}`,
      };
    }
    if (seenPaths.has(normalizedPath)) {
      return { ok: false, reason: `Duplicate snapshot path: ${normalizedPath}` };
    }
    seenPaths.add(normalizedPath);
    if (isForbiddenSnapshotPath(normalizedPath)) {
      return { ok: false, reason: `Forbidden snapshot path: ${normalizedPath}` };
    }
    const candidate = {
      path: fileRecord.path as string,
      type: fileRecord.type as WorkspaceSnapshotManifestFile["type"],
      mode: fileRecord.mode as string,
      size: fileRecord.size as number,
      sha256: fileRecord.sha256 as string,
      gitBlobSha1: fileRecord.gitBlobSha1 as string,
    };
    if (candidate.type === "file" && candidate.mode !== "100644" && candidate.mode !== "100755") {
      return {
        ok: false,
        reason: `Snapshot file ${candidate.path} has invalid file mode ${candidate.mode}.`,
      };
    }
    if (candidate.type === "symlink" && candidate.mode !== "120000") {
      return {
        ok: false,
        reason: `Snapshot symlink ${candidate.path} must use mode 120000.`,
      };
    }
    if (!["100644", "100755", "120000"].includes(candidate.mode)) {
      return {
        ok: false,
        reason: `Unsupported snapshot mode ${candidate.mode} for ${candidate.path}.`,
      };
    }
    files.push(candidate);
  }

  let gitObjectPack: WorkspaceSnapshotManifest["gitObjectPack"] | undefined;
  try {
    gitObjectPack = parseGitObjectPack(record.gitObjectPack);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Workspace snapshot gitObjectPack is invalid.",
    };
  }

  const manifest: WorkspaceSnapshotManifest = {
    schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
    product: WORKSPACE_SNAPSHOT_PRODUCT,
    role: WORKSPACE_SNAPSHOT_ROLE,
    packageName: P_DEV_PACKAGE_NAME,
    packageVersion: String(record.packageVersion).trim(),
    sourceRepository: WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY,
    sourceCommit: String(record.sourceCommit),
    snapshotContentId: String(record.snapshotContentId),
    snapshotSha256: String(record.snapshotSha256),
    gitRootTreeSha1: String(record.gitRootTreeSha1),
    fileCount: record.fileCount,
    generation: record.generation as WorkspaceSnapshotManifest["generation"],
    gitObjectPack,
    files: sortSnapshotManifestFiles(files),
  };

  if (manifest.fileCount !== manifest.files.length) {
    return {
      ok: false,
      reason: "Workspace snapshot manifest fileCount does not match files length.",
    };
  }

  const expectedSnapshotSha256 = computeSnapshotSha256(manifest.files);
  if (manifest.snapshotSha256 !== expectedSnapshotSha256) {
    return {
      ok: false,
      reason: "Workspace snapshot manifest snapshotSha256 does not match curated files.",
    };
  }

  const expectedContentId = computeSnapshotContentId({
    packageVersion: manifest.packageVersion,
    sourceCommit: manifest.sourceCommit,
    snapshotSha256: manifest.snapshotSha256,
  });
  if (manifest.snapshotContentId !== expectedContentId) {
    return {
      ok: false,
      reason: "Workspace snapshot manifest snapshotContentId does not match digest inputs.",
    };
  }

  const expectedRootTreeSha1 = computeSnapshotRootTreeSha1(manifest.files);
  if (manifest.gitRootTreeSha1 !== expectedRootTreeSha1) {
    return {
      ok: false,
      reason: "Workspace snapshot manifest gitRootTreeSha1 does not match file tree.",
    };
  }

  return { ok: true, manifest };
}

export function fingerprintWorkspaceSnapshotManifest(
  manifest: WorkspaceSnapshotManifest,
): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    product: manifest.product,
    role: manifest.role,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    sourceRepository: manifest.sourceRepository,
    sourceCommit: manifest.sourceCommit,
    snapshotContentId: manifest.snapshotContentId,
    snapshotSha256: manifest.snapshotSha256,
    gitRootTreeSha1: manifest.gitRootTreeSha1,
    fileCount: manifest.fileCount,
  });
}
