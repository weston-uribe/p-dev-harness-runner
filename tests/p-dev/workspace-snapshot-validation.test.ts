import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSnapshotFileSha256 } from "../../src/p-dev/workspace-snapshot-digest.js";
import { parseWorkspaceSnapshotManifestJson } from "../../src/p-dev/workspace-snapshot-manifest.js";
import {
  validateEmbeddedSnapshotFiles,
  validateSnapshotFileEntry,
} from "../../src/p-dev/workspace-snapshot-validation.js";
import {
  buildTestWorkspaceSnapshotManifest,
  createTestWorkspaceSnapshotRoot,
  TEST_SNAPSHOT_README_CONTENT,
  TEST_SNAPSHOT_README_PATH,
} from "../setup/test-workspace-snapshot-fixture.js";

describe("workspace-snapshot-validation", () => {
  let packageRoot = "";

  afterEach(async () => {
    if (packageRoot) {
      await import("node:fs/promises").then(({ rm }) =>
        rm(packageRoot, { recursive: true, force: true }),
      );
      packageRoot = "";
    }
  });

  it("accepts a valid embedded snapshot fixture", async () => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    packageRoot = fixture.packageRoot;
    const result = await validateEmbeddedSnapshotFiles({
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
    });
    expect(result).toEqual({ ok: true });
  });

  it.each([
    ["file bytes", async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
      await writeFile(
        path.join(fixture.snapshotRoot, "files", TEST_SNAPSHOT_README_PATH),
        Buffer.from("# tampered\n"),
      );
    }],
    [
      "declared size",
      async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
        fixture.manifest.files[0] = {
          ...fixture.manifest.files[0],
          size: fixture.manifest.files[0].size + 1,
        };
      },
    ],
    [
      "SHA-256",
      async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
        fixture.manifest.files[0] = {
          ...fixture.manifest.files[0],
          sha256: "0".repeat(64),
        };
      },
    ],
    [
      "git blob SHA",
      async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
        fixture.manifest.files[0] = {
          ...fixture.manifest.files[0],
          gitBlobSha1: "0".repeat(40),
        };
      },
    ],
    [
      "root-tree SHA",
      async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
        fixture.manifest.gitRootTreeSha1 = "0".repeat(40);
      },
    ],
    [
      "snapshot digest",
      async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
        fixture.manifest.snapshotSha256 = "0".repeat(64);
      },
    ],
    [
      "mode",
      async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
        fixture.manifest.files[0] = {
          ...fixture.manifest.files[0],
          mode: "120000",
          type: "file",
        };
      },
    ],
    [
      "type",
      async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
        fixture.manifest.files[0] = {
          ...fixture.manifest.files[0],
          type: "symlink",
          mode: "100644",
        };
      },
    ],
    [
      "package version content ID",
      async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
        fixture.manifest.snapshotContentId = "0".repeat(64);
      },
    ],
    [
      "duplicate path",
      async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
        fixture.manifest.files.push({ ...fixture.manifest.files[0] });
      },
    ],
    [
      "non-canonical path",
      async (fixture: Awaited<ReturnType<typeof createTestWorkspaceSnapshotRoot>>) => {
        fixture.manifest.files[0] = {
          ...fixture.manifest.files[0],
          path: "./README.md",
        };
      },
    ],
  ])("rejects tampered snapshot: %s", async (_label, mutate) => {
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.0");
    packageRoot = fixture.packageRoot;
    await mutate(fixture);
    const result = await validateEmbeddedSnapshotFiles({
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unsupported generation version in manifest parsing", () => {
    const manifest = buildTestWorkspaceSnapshotManifest("0.3.0");
    manifest.generation.version = 99;
    const parsed = parseWorkspaceSnapshotManifestJson(JSON.stringify(manifest));
    expect(parsed.ok).toBe(false);
  });

  it("rejects forbidden snapshot paths", () => {
    const manifest = buildTestWorkspaceSnapshotManifest("0.3.0");
    manifest.files.push({
      path: ".env.local",
      type: "file",
      mode: "100644",
      size: 1,
      sha256: computeSnapshotFileSha256(Buffer.from("x")),
      gitBlobSha1: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const result = validateSnapshotFileEntry(manifest.files[1]);
    expect(result.ok).toBe(false);
  });
});
