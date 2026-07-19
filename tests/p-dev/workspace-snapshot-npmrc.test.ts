import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeGitBlobSha1 } from "../../src/p-dev/git-object-plumbing.js";
import { buildWorkspaceSnapshotManifest } from "../../src/p-dev/workspace-snapshot-manifest.js";
import {
  listGitTreeEntries,
  readGitBlobContents,
  resolveGitCommit,
  selectSnapshotTreeEntries,
} from "../../src/p-dev/workspace-snapshot-git.js";
import {
  assertRequiredSnapshotPaths,
  isIncludedSnapshotPath,
  resolveSnapshotOutputPath,
  WORKSPACE_SNAPSHOT_POLICY,
} from "../../src/p-dev/workspace-snapshot-policy.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const EXPECTED_NPMRC = "legacy-peer-deps=true\n";

const SECRET_BEARING_NPMRC_PATTERNS = [
  /_auth(Token)?\s*=/i,
  /\/\/[^:]+:_password\s*=/i,
  /\/\/[^:]+:_authToken\s*=/i,
  /authToken/i,
  /always-auth\s*=\s*true/i,
  /registry\s*=\s*https?:\/\/[^\s]*:[^\s]+@/i,
  /BEGIN (RSA |OPENSSH )?PRIVATE KEY/,
  /sk-[a-z0-9-]+/i,
  /pk-lf-/i,
  /sk-lf-/i,
];

function assertNpmrcIsNonSecret(contents: string): void {
  expect(contents).toBe(EXPECTED_NPMRC);
  for (const pattern of SECRET_BEARING_NPMRC_PATTERNS) {
    expect(contents).not.toMatch(pattern);
  }
}

describe("workspace snapshot .npmrc contract", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("requires and includes .npmrc in the snapshot policy", () => {
    expect(WORKSPACE_SNAPSHOT_POLICY.requiredPaths).toContain(".npmrc");
    expect(WORKSPACE_SNAPSHOT_POLICY.includeFiles).toContain(".npmrc");
    expect(isIncludedSnapshotPath(".npmrc")).toBe(true);
  });

  it("selects the committed .npmrc into the workspace snapshot selection", async () => {
    const sourceCommit = await resolveGitCommit(repoRoot, "HEAD");
    const treeEntries = await listGitTreeEntries(repoRoot, sourceCommit);
    const selected = selectSnapshotTreeEntries(treeEntries);
    const selectedPaths = selected.map((entry) => entry.path);

    expect(selectedPaths).toContain(".npmrc");
    assertRequiredSnapshotPaths(selectedPaths);

    const npmrcEntries = selected.filter((entry) => entry.path === ".npmrc");
    expect(npmrcEntries).toHaveLength(1);
    const [npmrcBlob] = await readGitBlobContents(repoRoot, npmrcEntries);
    assertNpmrcIsNonSecret(npmrcBlob.content.toString("utf8"));
  });

  it("writes .npmrc into a generated managed workspace snapshot with only non-secret npm config", async () => {
    const sourceCommit = await resolveGitCommit(repoRoot, "HEAD");
    const treeEntries = await listGitTreeEntries(repoRoot, sourceCommit);
    const npmrcTree = selectSnapshotTreeEntries(treeEntries).find(
      (entry) => entry.path === ".npmrc",
    );
    expect(npmrcTree).toBeDefined();
    const [npmrcBlob] = await readGitBlobContents(repoRoot, [npmrcTree!]);
    const content = npmrcBlob.content;
    assertNpmrcIsNonSecret(content.toString("utf8"));

    const snapshotRoot = await mkdtemp(path.join(tmpdir(), "p-dev-npmrc-snapshot-"));
    tempDirs.push(snapshotRoot);
    const destination = resolveSnapshotOutputPath(snapshotRoot, ".npmrc");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);

    const managedWorkspace = await mkdtemp(path.join(tmpdir(), "p-dev-managed-ws-"));
    tempDirs.push(managedWorkspace);
    await writeFile(path.join(managedWorkspace, ".npmrc"), content);

    const manifest = buildWorkspaceSnapshotManifest({
      packageVersion: "0.4.0-test",
      sourceCommit,
      entries: [
        {
          path: ".npmrc",
          type: "file",
          mode: "100644",
          size: content.byteLength,
          content,
          gitBlobSha1: computeGitBlobSha1(content),
        },
      ],
    });

    expect(manifest.files.some((file) => file.path === ".npmrc")).toBe(true);
    expect(await readFile(destination, "utf8")).toBe(EXPECTED_NPMRC);
    expect(await readFile(path.join(managedWorkspace, ".npmrc"), "utf8")).toBe(
      EXPECTED_NPMRC,
    );
    assertNpmrcIsNonSecret(await readFile(path.join(managedWorkspace, ".npmrc"), "utf8"));
  });
});
