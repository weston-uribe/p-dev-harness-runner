export const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = 1;
export const WORKSPACE_SNAPSHOT_PRODUCT = "p-dev";
export const WORKSPACE_SNAPSHOT_ROLE = "workspace-snapshot";
export const WORKSPACE_SNAPSHOT_FORMAT = "p-dev-workspace-snapshot";
export const WORKSPACE_SNAPSHOT_FORMAT_VERSION = 1;
export const WORKSPACE_SNAPSHOT_SOURCE_REPOSITORY =
  "weston-uribe/agentic-product-development-harness";

export type WorkspaceSnapshotEntryType = "file" | "symlink";

export interface WorkspaceSnapshotTreeEntry {
  path: string;
  type: WorkspaceSnapshotEntryType;
  mode: string;
  size: number;
  sha256: string;
  gitBlobSha1: string;
  content: Buffer;
}

export interface WorkspaceSnapshotManifestFile {
  path: string;
  type: WorkspaceSnapshotEntryType;
  mode: string;
  size: number;
  sha256: string;
  gitBlobSha1: string;
}

export interface WorkspaceSnapshotManifest {
  schemaVersion: number;
  product: string;
  role: string;
  packageName: string;
  packageVersion: string;
  sourceRepository: string;
  sourceCommit: string;
  snapshotContentId: string;
  snapshotSha256: string;
  gitRootTreeSha1: string;
  fileCount: number;
  generation: {
    format: string;
    version: number;
    pathOrdering: string;
    digestAlgorithm: string;
    modeSource: string;
    byteSource: string;
  };
  gitObjectPack?: {
    packPath: string;
    indexPath: string;
    packSha1: string;
    packSha256: string;
    objectCount: number;
    packSizeBytes: number;
  };
  files: WorkspaceSnapshotManifestFile[];
}

export interface WorkspaceSnapshotGenerationResult {
  sourceRef: string;
  sourceCommit: string;
  packageVersion: string;
  manifest: WorkspaceSnapshotManifest;
  entries: WorkspaceSnapshotTreeEntry[];
}
