import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeGitObjectPackFromManifestFiles } from "./git-object-plumbing.js";
import {
  assertNoForbiddenSnapshotPaths,
  assertRequiredSnapshotPaths,
  resolveSnapshotOutputPath,
} from "./workspace-snapshot-policy.js";
import {
  assertCleanGitSource,
  listGitTreeEntries,
  readGitBlobContents,
  resolveGitCommit,
  selectSnapshotTreeEntries,
} from "./workspace-snapshot-git.js";
import { buildWorkspaceSnapshotManifest } from "./workspace-snapshot-manifest.js";
import type {
  WorkspaceSnapshotGenerationResult,
  WorkspaceSnapshotTreeEntry,
} from "./workspace-snapshot-types.js";
import { computeSnapshotFileSha256 } from "./workspace-snapshot-digest.js";

export interface GenerateWorkspaceSnapshotInput {
  repoRoot: string;
  packageVersion: string;
  sourceRef?: string;
  outputDir: string;
}

export async function generateWorkspaceSnapshot(
  input: GenerateWorkspaceSnapshotInput,
): Promise<WorkspaceSnapshotGenerationResult> {
  const sourceRef = input.sourceRef ?? "HEAD";
  await assertCleanGitSource(input.repoRoot, sourceRef);
  const sourceCommit = await resolveGitCommit(input.repoRoot, sourceRef);
  const treeEntries = await listGitTreeEntries(input.repoRoot, sourceCommit);
  const selectedEntries = selectSnapshotTreeEntries(treeEntries);
  const selectedPaths = selectedEntries.map((entry) => entry.path);
  assertRequiredSnapshotPaths(selectedPaths);
  assertNoForbiddenSnapshotPaths(selectedPaths);

  const objectEntries = await readGitBlobContents(
    input.repoRoot,
    selectedEntries,
  );
  const manifest = buildWorkspaceSnapshotManifest({
    packageVersion: input.packageVersion,
    sourceCommit,
    entries: objectEntries,
  });

  const filesDir = path.join(input.outputDir, "files");
  await mkdir(filesDir, { recursive: true });
  const snapshotEntries: WorkspaceSnapshotTreeEntry[] = [];

  for (const entry of objectEntries) {
    const sha256 = computeSnapshotFileSha256(entry.content);
    const destination = resolveSnapshotOutputPath(input.outputDir, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.content);
    snapshotEntries.push({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      sha256,
      gitBlobSha1: entry.gitBlobSha1,
      content: entry.content,
    });
  }

  const blobContentsBySha = new Map(
    snapshotEntries.map((entry) => [entry.gitBlobSha1, entry.content] as const),
  );
  const pack = writeGitObjectPackFromManifestFiles({
    outputDir: path.join(input.outputDir, "object-pack"),
    files: manifest.files,
    blobContentsBySha,
    expectedRootTreeSha: manifest.gitRootTreeSha1,
  });
  const packPath = path.relative(input.outputDir, pack.packPath);
  const indexPath = path.relative(input.outputDir, pack.indexPath);
  manifest.gitObjectPack = {
    packPath,
    indexPath,
    packSha1: pack.packSha1,
    packSha256: computeSnapshotFileSha256(await readFile(pack.packPath)),
    objectCount: pack.objectCount,
    packSizeBytes: pack.packSizeBytes,
  };

  const manifestPath = path.join(input.outputDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    sourceRef,
    sourceCommit,
    packageVersion: input.packageVersion,
    manifest,
    entries: snapshotEntries,
  };
}

export async function readWorkspaceSnapshotManifest(
  snapshotRoot: string,
): Promise<WorkspaceSnapshotGenerationResult["manifest"]> {
  const manifestPath = path.join(snapshotRoot, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const { parseWorkspaceSnapshotManifestJson } = await import(
    "./workspace-snapshot-manifest.js"
  );
  const parsed = parseWorkspaceSnapshotManifestJson(raw);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed.manifest;
}

export async function loadWorkspaceSnapshotEntryContent(input: {
  snapshotRoot: string;
  path: string;
  expectedSha256: string;
}): Promise<Buffer> {
  const destination = resolveSnapshotOutputPath(input.snapshotRoot, input.path);
  const content = await readFile(destination);
  const sha256 = computeSnapshotFileSha256(content);
  if (sha256 !== input.expectedSha256) {
    throw new Error(
      `Workspace snapshot file ${input.path} failed integrity check (expected ${input.expectedSha256}, got ${sha256}).`,
    );
  }
  return content;
}
