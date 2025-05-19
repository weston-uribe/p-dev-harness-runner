import { createHash } from "node:crypto";
import type { WorkspaceSnapshotManifest } from "../p-dev/workspace-snapshot-types.js";
import {
  isIncludedSnapshotPath,
  isForbiddenSnapshotPath,
} from "../p-dev/workspace-snapshot-policy.js";
import { loadWorkspaceSnapshotEntryContent } from "../p-dev/workspace-snapshot-generator.js";
import { loadEmbeddedWorkspaceSnapshot } from "./harness-workspace-snapshot-loader.js";
import {
  HARNESS_MANAGED_REPO_MARKER_FILE,
  buildHarnessSnapshotManagedRepoMarker,
  parseHarnessManagedRepoMarkerJson,
  validateManagedMarkerForReconnect,
  type HarnessManagedRepoMarker,
} from "./harness-managed-repo-marker.js";
import { deriveProvisioningCommitIdentity } from "./harness-snapshot-provisioning-helpers.js";
import {
  compareThreeWayUpgrade,
  extractFileHashesFromManifest,
  extractFileHashesFromMarker,
  type FileHashMap,
} from "./runner-upgrade-three-way.js";
import type { RunnerUpgradeGitHubProvider } from "./runner-upgrade-provider.js";
import {
  buildRunnerUpgradeBranchName,
  parseRunnerUpgradePrMarker,
} from "./runner-upgrade-types.js";
import { RUNNER_UPGRADE_HEARTBEAT_EVERY_FILES } from "./runner-upgrade-timeouts.js";

const OPERATOR_LOCAL_ONLY_PATHS = new Set([
  ".harness/config.local.json",
  ".env.local",
]);

export interface RunnerUpgradePackagedSnapshot {
  packageRoot: string;
  snapshotRoot: string;
  packageVersion: string;
  manifest: WorkspaceSnapshotManifest;
  fingerprint: string;
}

export interface RunnerUpgradeTargetContext {
  repoSlug: string;
  owner: string;
  repo: string;
  repositoryId: number;
  defaultBranch: string;
  defaultBranchHead: string;
  marker: HarnessManagedRepoMarker;
  packagedSnapshot: RunnerUpgradePackagedSnapshot;
}

export interface RunnerUpgradeCompareSuccess {
  ok: true;
  replacePaths: string[];
  deletePaths: string[];
}

export type RunnerUpgradeCompareFailure = {
  ok: false;
  status: "blocked_operator_conflicts" | "blocked_non_managed" | "blocked_unexpected_remote";
  conflictPaths?: string[];
  message: string;
};

export type RunnerUpgradeCompareResult =
  | RunnerUpgradeCompareSuccess
  | RunnerUpgradeCompareFailure;

export interface CompleteUpgradeCommitResult {
  snapshotCommitSha: string;
  snapshotTreeSha: string;
  markerCommitSha: string;
  candidateHeadSha: string;
  marker: HarnessManagedRepoMarker;
}

function sha256Content(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isOperatorLocalOnlyPath(filePath: string): boolean {
  if (OPERATOR_LOCAL_ONLY_PATHS.has(filePath)) {
    return true;
  }
  return isForbiddenSnapshotPath(filePath);
}

function findUnexpectedRemotePaths(input: {
  remoteTreePaths: string[];
  nextHashes: FileHashMap;
  previousHashes: FileHashMap | null;
}): string[] {
  const packagePaths = new Set(Object.keys(input.nextHashes));
  const unexpected: string[] = [];
  for (const remotePath of input.remoteTreePaths) {
    if (remotePath === HARNESS_MANAGED_REPO_MARKER_FILE) {
      continue;
    }
    if (!isIncludedSnapshotPath(remotePath)) {
      continue;
    }
    if (packagePaths.has(remotePath)) {
      continue;
    }
    if (isOperatorLocalOnlyPath(remotePath)) {
      continue;
    }
    if (input.previousHashes?.[remotePath]) {
      continue;
    }
    unexpected.push(remotePath);
  }
  return [...new Set(unexpected)].sort();
}

export async function loadRunnerUpgradePackagedSnapshot(
  moduleUrl: string,
): Promise<RunnerUpgradePackagedSnapshot | null> {
  const embedded = await loadEmbeddedWorkspaceSnapshot(moduleUrl);
  if (!embedded.ok) {
    return null;
  }
  return {
    packageRoot: embedded.packageRoot,
    snapshotRoot: embedded.snapshotRoot,
    packageVersion: embedded.packageVersion,
    manifest: embedded.manifest,
    fingerprint: embedded.fingerprint,
  };
}

export async function resolveRunnerUpgradeTargetContext(
  provider: RunnerUpgradeGitHubProvider,
  input: {
    repoSlug: string;
    repositoryId: number;
    requiredBaseSha: string;
    packagedSnapshot: RunnerUpgradePackagedSnapshot;
  },
): Promise<
  | { ok: true; context: RunnerUpgradeTargetContext }
  | { ok: false; code: string; message: string }
> {
  const [owner, repo] = input.repoSlug.split("/");
  if (!owner || !repo) {
    return {
      ok: false,
      code: "repository_identity_mismatch",
      message: `Invalid repository slug ${input.repoSlug}.`,
    };
  }

  const metadata = await provider.getRepositoryMetadata(owner, repo);
  if (!metadata) {
    return {
      ok: false,
      code: "repository_not_accessible",
      message: `Repository ${input.repoSlug} is not accessible.`,
    };
  }
  if (metadata.id !== input.repositoryId) {
    return {
      ok: false,
      code: "repository_identity_mismatch",
      message: `Repository ID mismatch for ${input.repoSlug}: expected ${input.repositoryId}, got ${metadata.id}.`,
    };
  }
  if (metadata.fullName !== input.repoSlug) {
    return {
      ok: false,
      code: "repository_identity_mismatch",
      message: `Repository full name mismatch: expected ${input.repoSlug}, got ${metadata.fullName}.`,
    };
  }

  const defaultBranchHead = await provider.getRepositoryDefaultBranchHead(
    owner,
    repo,
    metadata.defaultBranch,
  );
  if (defaultBranchHead !== input.requiredBaseSha) {
    return {
      ok: false,
      code: "main_baseline_mismatch",
      message: `Default branch head mismatch: expected ${input.requiredBaseSha}, found ${defaultBranchHead}.`,
    };
  }

  const markerRaw = await provider.readRepositoryFileContent(
    owner,
    repo,
    HARNESS_MANAGED_REPO_MARKER_FILE,
    defaultBranchHead,
  );
  if (!markerRaw) {
    return {
      ok: false,
      code: "blocked_non_managed",
      message: "Managed repository marker is missing on the default branch.",
    };
  }
  const parsed = parseHarnessManagedRepoMarkerJson(markerRaw);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "blocked_non_managed",
      message: parsed.reason,
    };
  }
  if (!parsed.marker.createdFromPackageSnapshot) {
    return {
      ok: false,
      code: "blocked_non_managed",
      message: "Managed repository was not created from a packaged workspace snapshot.",
    };
  }

  const reconnect = validateManagedMarkerForReconnect(
    parsed.marker,
    input.repoSlug,
    { repositoryId: metadata.id },
  );
  if (!reconnect.ok) {
    return {
      ok: false,
      code: "blocked_non_managed",
      message: reconnect.reason,
    };
  }

  return {
    ok: true,
    context: {
      repoSlug: input.repoSlug,
      owner,
      repo,
      repositoryId: metadata.id,
      defaultBranch: metadata.defaultBranch,
      defaultBranchHead,
      marker: parsed.marker,
      packagedSnapshot: input.packagedSnapshot,
    },
  };
}

async function buildRemoteFileHashes(
  provider: RunnerUpgradeGitHubProvider,
  input: {
    owner: string;
    repo: string;
    defaultBranchHead: string;
    paths: string[];
    onHeartbeat?: (progress: {
      filesInspected: number;
      filesTotal: number;
      lastCompletedBatch: string;
    }) => Promise<void>;
  },
): Promise<FileHashMap> {
  const hashes: FileHashMap = {};
  const total = input.paths.length;
  let inspected = 0;
  for (const filePath of input.paths) {
    const content = await provider.readRepositoryFileContent(
      input.owner,
      input.repo,
      filePath,
      input.defaultBranchHead,
    );
    inspected += 1;
    if (content !== null) {
      hashes[filePath] = sha256Content(content);
    }
    if (
      input.onHeartbeat &&
      (inspected % RUNNER_UPGRADE_HEARTBEAT_EVERY_FILES === 0 ||
        inspected === total)
    ) {
      await input.onHeartbeat({
        filesInspected: inspected,
        filesTotal: total,
        lastCompletedBatch: filePath,
      });
    }
  }
  return hashes;
}

export async function compareRunnerUpgradeSnapshots(
  provider: RunnerUpgradeGitHubProvider,
  context: RunnerUpgradeTargetContext,
  options?: {
    onHeartbeat?: (progress: {
      filesInspected: number;
      filesTotal: number;
      lastCompletedBatch: string;
    }) => Promise<void>;
  },
): Promise<RunnerUpgradeCompareResult> {
  const previousHashes = extractFileHashesFromMarker(context.marker);
  const nextHashes = extractFileHashesFromManifest(context.packagedSnapshot.manifest);
  const comparePaths = [
    ...new Set([
      ...Object.keys(previousHashes ?? {}),
      ...Object.keys(nextHashes),
    ]),
  ].sort();
  const remoteHashes = await buildRemoteFileHashes(provider, {
    owner: context.owner,
    repo: context.repo,
    defaultBranchHead: context.defaultBranchHead,
    paths: comparePaths,
    onHeartbeat: options?.onHeartbeat,
  });

  if (provider.listRepositoryTreePaths) {
    const treePaths = await provider.listRepositoryTreePaths(
      context.owner,
      context.repo,
      context.defaultBranchHead,
    );
    const unexpected = findUnexpectedRemotePaths({
      remoteTreePaths: treePaths.map((entry) => entry.path),
      nextHashes,
      previousHashes,
    });
    if (unexpected.length > 0) {
      return {
        ok: false,
        status: "blocked_unexpected_remote",
        message: `Unexpected remote paths outside packaged policy: ${unexpected.join(", ")}`,
      };
    }
  }

  const compare = compareThreeWayUpgrade({
    previousHashes,
    remoteHashes,
    nextHashes,
    previousSnapshotContentId:
      context.marker.createdFromPackageSnapshot?.snapshotContentId,
    remoteSnapshotContentId:
      context.marker.createdFromPackageSnapshot?.snapshotContentId,
    remoteTreeSha: context.marker.createdFromPackageSnapshot?.snapshotGitTreeSha1,
    previousTreeSha: context.marker.createdFromPackageSnapshot?.snapshotGitTreeSha1,
  });

  if (!compare.ok) {
    return {
      ok: false,
      status:
        compare.code === "operator_conflicts"
          ? "blocked_operator_conflicts"
          : "blocked_non_managed",
      conflictPaths: compare.conflictPaths,
      message: compare.message,
    };
  }

  return {
    ok: true,
    replacePaths: compare.replacePaths,
    deletePaths: compare.deletePaths,
  };
}

export async function findExistingUpgradePullRequest(
  provider: RunnerUpgradeGitHubProvider,
  input: {
    owner: string;
    repo: string;
    repositoryId: number;
    snapshotContentId: string;
    defaultBranch: string;
    branchName: string;
  },
): Promise<{ number: number; htmlUrl: string; headSha: string } | null> {
  const openPulls = await provider.listPullRequests(input.owner, input.repo, {
    state: "open",
    base: input.defaultBranch,
  });
  for (const pull of openPulls) {
    const marker = parseRunnerUpgradePrMarker(pull.body);
    if (
      marker &&
      marker.repositoryId === input.repositoryId &&
      marker.snapshotContentId === input.snapshotContentId
    ) {
      return {
        number: pull.number,
        htmlUrl: pull.htmlUrl,
        headSha: pull.headSha,
      };
    }
  }
  const byBranch = openPulls.find((pull) => pull.headRef === input.branchName);
  if (byBranch) {
    return {
      number: byBranch.number,
      htmlUrl: byBranch.htmlUrl,
      headSha: byBranch.headSha,
    };
  }
  return null;
}

export function buildExpectedUpgradeMarker(input: {
  context: RunnerUpgradeTargetContext;
  snapshotCommitSha: string;
  operationId: string;
}): HarnessManagedRepoMarker {
  return buildHarnessSnapshotManagedRepoMarker({
    repository: input.context.repoSlug,
    repositoryId: input.context.repositoryId,
    manifest: input.context.packagedSnapshot.manifest,
    snapshotCommitSha: input.snapshotCommitSha,
    defaultBranch: input.context.defaultBranch,
    operationId: input.operationId,
    pDevVersion: input.context.packagedSnapshot.packageVersion,
  });
}

export function markerHasCompleteSnapshotCommitSha(marker: HarnessManagedRepoMarker): boolean {
  const snapshotCommitSha =
    marker.createdFromPackageSnapshot?.snapshotCommitSha;
  return (
    typeof snapshotCommitSha === "string" &&
    snapshotCommitSha.length > 0 &&
    snapshotCommitSha !== "pending"
  );
}

export async function readManagedMarkerAtRef(
  provider: RunnerUpgradeGitHubProvider,
  input: {
    owner: string;
    repo: string;
    ref: string;
  },
): Promise<
  | { ok: true; marker: HarnessManagedRepoMarker }
  | { ok: false; reason: string }
> {
  const raw = await provider.readRepositoryFileContent(
    input.owner,
    input.repo,
    HARNESS_MANAGED_REPO_MARKER_FILE,
    input.ref,
  );
  if (!raw) {
    return { ok: false, reason: "Managed marker is missing on candidate head." };
  }
  const parsed = parseHarnessManagedRepoMarkerJson(raw);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  if (!markerHasCompleteSnapshotCommitSha(parsed.marker)) {
    return {
      ok: false,
      reason: "Managed marker snapshotCommitSha is provisional or missing.",
    };
  }
  return { ok: true, marker: parsed.marker };
}

export function markerMatchesPackagedSnapshotIdentity(
  marker: HarnessManagedRepoMarker,
  input: {
    repoSlug: string;
    repositoryId: number;
    manifest: WorkspaceSnapshotManifest;
    snapshotCommitSha: string;
  },
): boolean {
  const snapshot = marker.createdFromPackageSnapshot;
  if (!snapshot) {
    return false;
  }
  return (
    marker.repository === input.repoSlug &&
    marker.repositoryId === input.repositoryId &&
    snapshot.snapshotContentId === input.manifest.snapshotContentId &&
    snapshot.snapshotSha256 === input.manifest.snapshotSha256 &&
    snapshot.snapshotGitTreeSha1 === input.manifest.gitRootTreeSha1 &&
    snapshot.snapshotCommitSha === input.snapshotCommitSha &&
    snapshot.sourceCommit === input.manifest.sourceCommit
  );
}

export async function verifyCompleteCandidateHead(
  provider: RunnerUpgradeGitHubProvider,
  input: {
    context: RunnerUpgradeTargetContext;
    headSha: string;
    expectedSnapshotCommitSha: string;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const markerResult = await readManagedMarkerAtRef(provider, {
    owner: input.context.owner,
    repo: input.context.repo,
    ref: input.headSha,
  });
  if (!markerResult.ok) {
    return markerResult;
  }
  if (
    !markerMatchesPackagedSnapshotIdentity(markerResult.marker, {
      repoSlug: input.context.repoSlug,
      repositoryId: input.context.repositoryId,
      manifest: input.context.packagedSnapshot.manifest,
      snapshotCommitSha: input.expectedSnapshotCommitSha,
    })
  ) {
    return {
      ok: false,
      reason: "Candidate marker does not match expected packaged snapshot identity.",
    };
  }
  const headCommit = await provider.getGitCommit(
    input.context.owner,
    input.context.repo,
    input.headSha,
  );
  const parentSha = headCommit.parents[0]?.sha;
  if (!parentSha) {
    return { ok: false, reason: "Candidate marker commit is missing a parent." };
  }
  if (parentSha !== input.expectedSnapshotCommitSha) {
    return {
      ok: false,
      reason: "Candidate marker parent does not match snapshotCommitSha.",
    };
  }
  return { ok: true };
}

async function updateOrCreateBranchRef(
  provider: RunnerUpgradeGitHubProvider,
  input: {
    owner: string;
    repo: string;
    branchName: string;
    sha: string;
  },
): Promise<void> {
  let branchHeadSha: string | null = null;
  try {
    const existingRef = await provider.getGitRef(
      input.owner,
      input.repo,
      input.branchName,
    );
    branchHeadSha = existingRef.object.sha;
  } catch {
    branchHeadSha = null;
  }

  if (branchHeadSha) {
    await provider.updateGitRef({
      owner: input.owner,
      repo: input.repo,
      ref: input.branchName,
      sha: input.sha,
      expectedSha: branchHeadSha,
    });
  } else if (provider.createGitRef) {
    await provider.createGitRef({
      owner: input.owner,
      repo: input.repo,
      ref: input.branchName,
      sha: input.sha,
    });
  } else {
    await provider.updateGitRef({
      owner: input.owner,
      repo: input.repo,
      ref: input.branchName,
      sha: input.sha,
    });
  }
}

export async function buildProvisionalUpgradeCommitOnBranch(
  provider: RunnerUpgradeGitHubProvider,
  context: RunnerUpgradeTargetContext,
  input: {
    operationId: string;
    branchName: string;
    replacePaths: string[];
    deletePaths: string[];
  },
): Promise<{ commitSha: string; headSha: string }> {
  const parentSha = context.defaultBranchHead;
  const parentCommit = await provider.getGitCommit(
    context.owner,
    context.repo,
    parentSha,
  );
  const parentTreeSha = parentCommit.tree.sha;
  const manifest = context.packagedSnapshot.manifest;
  const blobShaByPath = new Map<string, string>();

  for (const filePath of input.replacePaths) {
    const manifestFile = manifest.files.find((file) => file.path === filePath);
    if (!manifestFile) {
      throw new Error(`Packaged snapshot is missing ${filePath}.`);
    }
    const content = await loadWorkspaceSnapshotEntryContent({
      snapshotRoot: context.packagedSnapshot.snapshotRoot,
      path: filePath,
      expectedSha256: manifestFile.sha256,
    });
    const blob = await provider.createGitBlob({
      owner: context.owner,
      repo: context.repo,
      content,
    });
    blobShaByPath.set(filePath, blob.sha);
  }

  const markerContent = JSON.stringify(
    buildHarnessSnapshotManagedRepoMarker({
      repository: context.repoSlug,
      repositoryId: context.repositoryId,
      manifest,
      snapshotCommitSha: "pending",
      defaultBranch: context.defaultBranch,
      operationId: input.operationId,
      pDevVersion: context.packagedSnapshot.packageVersion,
    }),
    null,
    2,
  );
  const markerBlob = await provider.createGitBlob({
    owner: context.owner,
    repo: context.repo,
    content: Buffer.from(`${markerContent}\n`, "utf8"),
  });
  blobShaByPath.set(HARNESS_MANAGED_REPO_MARKER_FILE, markerBlob.sha);

  const treeEntries = [
    ...input.replacePaths.map((filePath) => {
      const manifestFile = manifest.files.find((file) => file.path === filePath);
      return {
        path: filePath,
        mode: manifestFile?.mode ?? "100644",
        type: "blob" as const,
        sha: blobShaByPath.get(filePath)!,
      };
    }),
    ...input.deletePaths.map((filePath) => ({
      path: filePath,
      mode: "100644",
      type: "blob" as const,
      sha: null as unknown as string,
    })),
    {
      path: HARNESS_MANAGED_REPO_MARKER_FILE,
      mode: "100644",
      type: "blob" as const,
      sha: markerBlob.sha,
    },
  ];

  const tree = await provider.createGitTree({
    owner: context.owner,
    repo: context.repo,
    baseTree: parentTreeSha,
    tree: treeEntries,
  });

  const commitIdentity = deriveProvisioningCommitIdentity({
    operationId: input.operationId,
    sourceCommit: manifest.sourceCommit,
  });
  const commit = await provider.createGitCommit({
    owner: context.owner,
    repo: context.repo,
    message: `Update p-dev runner to ${manifest.packageVersion}`,
    tree: tree.sha,
    parents: [parentSha],
    author: commitIdentity,
    committer: commitIdentity,
  });

  await updateOrCreateBranchRef(provider, {
    owner: context.owner,
    repo: context.repo,
    branchName: input.branchName,
    sha: commit.sha,
  });

  return { commitSha: commit.sha, headSha: commit.sha };
}

export async function buildCompleteUpgradeCommitsOnBranch(
  provider: RunnerUpgradeGitHubProvider,
  context: RunnerUpgradeTargetContext,
  input: {
    operationId: string;
    branchName: string;
    replacePaths: string[];
    deletePaths: string[];
    requiredBaseSha: string;
  },
): Promise<CompleteUpgradeCommitResult> {
  const parentSha = context.defaultBranchHead;
  if (parentSha !== input.requiredBaseSha) {
    throw new Error(
      `Main drift detected during prepare (expected ${input.requiredBaseSha}, found ${parentSha}).`,
    );
  }

  const parentCommit = await provider.getGitCommit(
    context.owner,
    context.repo,
    parentSha,
  );
  const parentTreeSha = parentCommit.tree.sha;
  const manifest = context.packagedSnapshot.manifest;
  const blobShaByPath = new Map<string, string>();

  for (const filePath of input.replacePaths) {
    const manifestFile = manifest.files.find((file) => file.path === filePath);
    if (!manifestFile) {
      throw new Error(`Packaged snapshot is missing ${filePath}.`);
    }
    const content = await loadWorkspaceSnapshotEntryContent({
      snapshotRoot: context.packagedSnapshot.snapshotRoot,
      path: filePath,
      expectedSha256: manifestFile.sha256,
    });
    const blob = await provider.createGitBlob({
      owner: context.owner,
      repo: context.repo,
      content,
    });
    blobShaByPath.set(filePath, blob.sha);
  }

  const workspaceTreeEntries = [
    ...input.replacePaths.map((filePath) => {
      const manifestFile = manifest.files.find((file) => file.path === filePath);
      return {
        path: filePath,
        mode: manifestFile?.mode ?? "100644",
        type: "blob" as const,
        sha: blobShaByPath.get(filePath)!,
      };
    }),
    ...input.deletePaths.map((filePath) => ({
      path: filePath,
      mode: "100644",
      type: "blob" as const,
      sha: null as unknown as string,
    })),
  ];

  const snapshotTree = await provider.createGitTree({
    owner: context.owner,
    repo: context.repo,
    baseTree: parentTreeSha,
    tree: workspaceTreeEntries,
  });

  const commitIdentity = deriveProvisioningCommitIdentity({
    operationId: input.operationId,
    sourceCommit: manifest.sourceCommit,
  });
  const snapshotCommit = await provider.createGitCommit({
    owner: context.owner,
    repo: context.repo,
    message: `Update p-dev runner to ${manifest.packageVersion}`,
    tree: snapshotTree.sha,
    parents: [parentSha],
    author: commitIdentity,
    committer: commitIdentity,
  });

  const expectedMarker = buildExpectedUpgradeMarker({
    context,
    snapshotCommitSha: snapshotCommit.sha,
    operationId: input.operationId,
  });
  const markerContent = `${JSON.stringify(expectedMarker, null, 2)}\n`;
  const markerBlob = await provider.createGitBlob({
    owner: context.owner,
    repo: context.repo,
    content: Buffer.from(markerContent, "utf8"),
  });
  const markerTree = await provider.createGitTree({
    owner: context.owner,
    repo: context.repo,
    baseTree: snapshotTree.sha,
    tree: [
      {
        path: HARNESS_MANAGED_REPO_MARKER_FILE,
        mode: "100644",
        type: "blob" as const,
        sha: markerBlob.sha,
      },
    ],
  });
  if (markerTree.sha === snapshotTree.sha) {
    throw new Error(
      "Marker tree must overlay the snapshot tree rather than replace it.",
    );
  }

  const markerCommit = await provider.createGitCommit({
    owner: context.owner,
    repo: context.repo,
    message: "Update p-dev managed harness workspace marker",
    tree: markerTree.sha,
    parents: [snapshotCommit.sha],
    author: commitIdentity,
    committer: commitIdentity,
  });

  await updateOrCreateBranchRef(provider, {
    owner: context.owner,
    repo: context.repo,
    branchName: input.branchName,
    sha: markerCommit.sha,
  });

  return {
    snapshotCommitSha: snapshotCommit.sha,
    snapshotTreeSha: snapshotTree.sha,
    markerCommitSha: markerCommit.sha,
    candidateHeadSha: markerCommit.sha,
    marker: expectedMarker,
  };
}

export function buildRunnerUpgradeBranchNameForManifest(
  manifest: WorkspaceSnapshotManifest,
): string {
  return buildRunnerUpgradeBranchName(manifest.snapshotContentId);
}
