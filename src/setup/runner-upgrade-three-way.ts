import type { WorkspaceSnapshotManifest } from "../p-dev/workspace-snapshot-types.js";
import type { HarnessManagedRepoMarker } from "./harness-managed-repo-marker.js";

export type FileHashMap = Record<string, string>;

export type ThreeWayUpgradeCompareInput = {
  previousHashes: FileHashMap | null;
  remoteHashes: FileHashMap;
  nextHashes: FileHashMap;
  previousSnapshotContentId?: string;
  remoteSnapshotContentId?: string;
  remoteTreeSha?: string;
  previousTreeSha?: string;
};

export type ThreeWayUpgradeCompareSuccess = {
  ok: true;
  replacePaths: string[];
  deletePaths: string[];
};

export type ThreeWayUpgradeCompareFailure = {
  ok: false;
  code: "operator_conflicts" | "legacy_unsafe";
  conflictPaths: string[];
  message: string;
};

export type ThreeWayUpgradeCompareResult =
  | ThreeWayUpgradeCompareSuccess
  | ThreeWayUpgradeCompareFailure;

export function extractFileHashesFromManifest(
  manifest: WorkspaceSnapshotManifest,
): FileHashMap {
  const hashes: FileHashMap = {};
  for (const file of manifest.files) {
    hashes[file.path] = file.sha256;
  }
  return hashes;
}

export function extractFileHashesFromMarker(
  marker: HarnessManagedRepoMarker,
): FileHashMap | null {
  const fileHashes = marker.createdFromPackageSnapshot?.fileHashes;
  if (!fileHashes || typeof fileHashes !== "object") {
    return null;
  }
  const entries = Object.entries(fileHashes).filter(
    ([path, hash]) => typeof path === "string" && path.length > 0 && typeof hash === "string" && hash.length > 0,
  );
  if (entries.length === 0) {
    return null;
  }
  return Object.fromEntries(entries);
}

function sortedPaths(map: FileHashMap): string[] {
  return Object.keys(map).sort();
}

function collectChangedPaths(input: {
  previousHashes: FileHashMap;
  nextHashes: FileHashMap;
}): { replacePaths: string[]; deletePaths: string[] } {
  const replacePaths: string[] = [];
  const deletePaths: string[] = [];
  const allPaths = new Set([
    ...sortedPaths(input.previousHashes),
    ...sortedPaths(input.nextHashes),
  ]);

  for (const filePath of [...allPaths].sort()) {
    const previousHash = input.previousHashes[filePath];
    const nextHash = input.nextHashes[filePath];
    if (previousHash === nextHash) {
      continue;
    }
    if (nextHash === undefined) {
      deletePaths.push(filePath);
      continue;
    }
    replacePaths.push(filePath);
  }

  return { replacePaths, deletePaths };
}

function resolvePreviousHashesForCompare(
  input: ThreeWayUpgradeCompareInput,
): { hashes: FileHashMap } | ThreeWayUpgradeCompareFailure {
  if (input.previousHashes) {
    return { hashes: input.previousHashes };
  }

  const remoteTreeExactMatch =
    Boolean(input.remoteTreeSha) &&
    Boolean(input.previousTreeSha) &&
    input.remoteTreeSha === input.previousTreeSha;
  const snapshotIdentityMatch =
    Boolean(input.previousSnapshotContentId) &&
    Boolean(input.remoteSnapshotContentId) &&
    input.remoteSnapshotContentId === input.previousSnapshotContentId;

  if (snapshotIdentityMatch && remoteTreeExactMatch) {
    return { hashes: input.remoteHashes };
  }

  return {
    ok: false,
    code: "legacy_unsafe",
    conflictPaths: [],
    message: "legacy_marker_without_hashes",
  };
}

export function compareThreeWayUpgrade(
  input: ThreeWayUpgradeCompareInput,
): ThreeWayUpgradeCompareResult {
  const previousResolved = resolvePreviousHashesForCompare(input);
  if ("ok" in previousResolved) {
    return previousResolved;
  }
  const previousHashes = previousResolved.hashes;

  const { replacePaths, deletePaths } = collectChangedPaths({
    previousHashes,
    nextHashes: input.nextHashes,
  });
  const managedChangePaths = [...replacePaths, ...deletePaths];
  const conflictPaths: string[] = [];

  for (const filePath of managedChangePaths) {
    const previousHash = previousHashes[filePath];
    const remoteHash = input.remoteHashes[filePath];
    if (previousHash === undefined) {
      if (remoteHash !== undefined) {
        conflictPaths.push(filePath);
      }
      continue;
    }
    if (remoteHash !== previousHash) {
      conflictPaths.push(filePath);
    }
  }

  if (conflictPaths.length > 0) {
    return {
      ok: false,
      code: "operator_conflicts",
      conflictPaths: [...new Set(conflictPaths)].sort(),
      message: "Operator edits conflict with the packaged runner upgrade.",
    };
  }

  return {
    ok: true,
    replacePaths,
    deletePaths,
  };
}
