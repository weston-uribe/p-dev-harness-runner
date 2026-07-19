import { describe, expect, it } from "vitest";
import {
  buildHarnessSnapshotManagedRepoMarker,
  type HarnessManagedRepoMarker,
} from "../../src/setup/harness-managed-repo-marker.js";
import type { WorkspaceSnapshotManifest } from "../../src/p-dev/workspace-snapshot-types.js";
import {
  compareThreeWayUpgrade,
  extractFileHashesFromManifest,
  extractFileHashesFromMarker,
  type FileHashMap,
} from "../../src/setup/runner-upgrade-three-way.js";
import {
  buildRunnerUpgradeBranchName,
  buildRunnerUpgradePrMarker,
  parseRunnerUpgradePrMarker,
  runnerUpgradePhaseLabel,
  runnerUpgradeStatusLabel,
} from "../../src/setup/runner-upgrade-types.js";

function manifestWithFiles(
  files: Array<{ path: string; sha256: string }>,
  snapshotContentId = "snap-v2",
): WorkspaceSnapshotManifest {
  return {
    schemaVersion: 1,
    product: "p-dev",
    role: "workspace-snapshot",
    packageName: "p-dev-harness",
    packageVersion: "0.3.1",
    sourceRepository: "weston-uribe/agentic-product-development-harness",
    sourceCommit: "commit-v2",
    snapshotContentId,
    snapshotSha256: "digest-v2",
    gitRootTreeSha1: "tree-v2",
    fileCount: files.length,
    generation: {
      format: "p-dev-workspace-snapshot",
      version: 1,
      pathOrdering: "lexicographic",
      digestAlgorithm: "sha256",
      modeSource: "git",
      byteSource: "working-tree",
    },
    files: files.map((file) => ({
      path: file.path,
      type: "file" as const,
      mode: "100644",
      size: 10,
      sha256: file.sha256,
      gitBlobSha1: `blob-${file.path}`,
    })),
  };
}

function markerFromManifest(
  manifest: WorkspaceSnapshotManifest,
  overrides: Partial<HarnessManagedRepoMarker> = {},
): HarnessManagedRepoMarker {
  return {
    ...buildHarnessSnapshotManagedRepoMarker({
      repository: "owner/p-dev-harness",
      repositoryId: 42,
      manifest,
      snapshotCommitSha: "marker-commit",
      defaultBranch: "main",
    }),
    ...overrides,
  };
}

describe("runner upgrade types", () => {
  it("builds and parses snapshot-keyed PR markers", () => {
    const marker = buildRunnerUpgradePrMarker(42, "snap-content-id-abc");
    expect(marker).toBe("<!-- p-dev-runner-upgrade:42:snap-content-id-abc -->");
    expect(parseRunnerUpgradePrMarker(`Title\n\n${marker}\n`)).toEqual({
      repositoryId: 42,
      snapshotContentId: "snap-content-id-abc",
    });
  });

  it("builds deterministic branch names", () => {
    expect(buildRunnerUpgradeBranchName("snap-content-id-abc")).toBe(
      "harness/update-runner-snap-content",
    );
  });

  it("exposes UI labels for phases and statuses", () => {
    expect(runnerUpgradePhaseLabel("running-configuration-canary")).toBe(
      "Running configuration canary",
    );
    expect(runnerUpgradeStatusLabel("partially_updated")).toBe("Partially updated");
  });
});

describe("runner upgrade three-way compare", () => {
  it("allows a clean upgrade when remote still matches previous snapshot", () => {
    const previous: FileHashMap = {
      "README.md": "aaa",
      ".github/workflows/harness-auto-runner.yml": "bbb",
    };
    const next: FileHashMap = {
      "README.md": "aaa-next",
      ".github/workflows/harness-auto-runner.yml": "bbb-next",
      ".github/workflows/p-dev-runner-config-canary.yml": "ccc-next",
    };

    const result = compareThreeWayUpgrade({
      previousHashes: previous,
      remoteHashes: { ...previous },
      nextHashes: next,
    });

    expect(result).toEqual({
      ok: true,
      replacePaths: [
        ".github/workflows/harness-auto-runner.yml",
        ".github/workflows/p-dev-runner-config-canary.yml",
        "README.md",
      ],
      deletePaths: [],
    });
  });

  it("blocks operator conflicts when remote diverged from previous snapshot", () => {
    const previous: FileHashMap = {
      "README.md": "aaa",
      ".github/workflows/harness-auto-runner.yml": "bbb",
    };
    const next: FileHashMap = {
      "README.md": "aaa-next",
      ".github/workflows/harness-auto-runner.yml": "bbb-next",
    };

    const result = compareThreeWayUpgrade({
      previousHashes: previous,
      remoteHashes: {
        ...previous,
        "README.md": "aaa-edited-by-operator",
      },
      nextHashes: next,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("operator_conflicts");
    expect(result.conflictPaths).toEqual(["README.md"]);
  });

  it("allows legacy exact-match upgrades without stored per-file hashes", () => {
    const manifest = manifestWithFiles(
      [
        { path: "README.md", sha256: "aaa" },
        { path: ".github/workflows/harness-auto-runner.yml", sha256: "bbb" },
      ],
      "snap-v1",
    );
    const nextManifest = manifestWithFiles(
      [
        { path: "README.md", sha256: "aaa-next" },
        { path: ".github/workflows/harness-auto-runner.yml", sha256: "bbb-next" },
      ],
      "snap-v2",
    );
    const remoteHashes = extractFileHashesFromManifest(manifest);
    const nextHashes = extractFileHashesFromManifest(nextManifest);

    const result = compareThreeWayUpgrade({
      previousHashes: null,
      remoteHashes,
      nextHashes,
      previousSnapshotContentId: "snap-v1",
      remoteSnapshotContentId: "snap-v1",
      previousTreeSha: "tree-v1",
      remoteTreeSha: "tree-v1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.replacePaths.length).toBeGreaterThan(0);
  });

  it("blocks legacy markers without hashes when remote identity does not match", () => {
    const nextManifest = manifestWithFiles([{ path: "README.md", sha256: "aaa-next" }]);
    const result = compareThreeWayUpgrade({
      previousHashes: null,
      remoteHashes: { "README.md": "aaa-remote" },
      nextHashes: extractFileHashesFromManifest(nextManifest),
      previousSnapshotContentId: "snap-v1",
      remoteSnapshotContentId: "snap-v2",
      previousTreeSha: "tree-v1",
      remoteTreeSha: "tree-v2",
    });

    expect(result).toEqual({
      ok: false,
      code: "legacy_unsafe",
      conflictPaths: [],
      message: "legacy_marker_without_hashes",
    });
  });

  it("extracts per-file hashes from manifest and marker provenance", () => {
    const manifest = manifestWithFiles([{ path: "README.md", sha256: "aaa" }]);
    expect(extractFileHashesFromManifest(manifest)).toEqual({
      "README.md": "aaa",
    });

    const marker = markerFromManifest(manifest);
    expect(extractFileHashesFromMarker(marker)).toEqual({
      "README.md": "aaa",
    });

    const legacyMarker = markerFromManifest(manifest, {
      createdFromPackageSnapshot: {
        ...marker.createdFromPackageSnapshot!,
        fileHashes: undefined,
      },
    });
    expect(extractFileHashesFromMarker(legacyMarker)).toBeNull();
  });
});
