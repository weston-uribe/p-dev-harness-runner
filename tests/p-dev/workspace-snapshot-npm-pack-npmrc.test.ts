import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSnapshotOutputPath } from "../../src/p-dev/workspace-snapshot-policy.js";

describe("workspace snapshot npm pack .npmrc alias", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("keeps npmrc.snapshot inside npm pack while raw .npmrc is stripped", () => {
    const root = mkdtempSync(path.join(tmpdir(), "p-dev-npmrc-pack-"));
    tempDirs.push(root);
    const pkgDir = path.join(root, "pkg");
    mkdirSync(pkgDir, { recursive: true });

    const snapshotRoot = path.join(pkgDir, "workspace-snapshot");
    const aliased = resolveSnapshotOutputPath(snapshotRoot, ".npmrc");
    mkdirSync(path.dirname(aliased), { recursive: true });
    writeFileSync(aliased, "legacy-peer-deps=true\n", "utf8");
    // Control: a literal .npmrc next to the alias must not survive npm pack.
    writeFileSync(
      path.join(snapshotRoot, "files", ".npmrc"),
      "legacy-peer-deps=true\n",
      "utf8",
    );
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "npmrc-alias-pack-check",
          version: "1.0.0",
          files: ["workspace-snapshot"],
        },
        null,
        2,
      ),
      "utf8",
    );

    execFileSync("npm", ["pack", "--pack-destination", root], {
      cwd: pkgDir,
      stdio: "pipe",
    });
    const tarball = path.join(root, "npmrc-alias-pack-check-1.0.0.tgz");
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    expect(listing).toContain("package/workspace-snapshot/files/npmrc.snapshot");
    expect(listing).not.toContain("package/workspace-snapshot/files/.npmrc");
    const extracted = execFileSync(
      "tar",
      ["-xOf", tarball, "package/workspace-snapshot/files/npmrc.snapshot"],
      { encoding: "utf8" },
    );
    expect(extracted).toBe("legacy-peer-deps=true\n");
    expect(readFileSync(aliased, "utf8")).toBe("legacy-peer-deps=true\n");
  });

  it("keeps gitignore.snapshot inside npm pack while raw .gitignore is stripped", () => {
    const root = mkdtempSync(path.join(tmpdir(), "p-dev-gitignore-pack-"));
    tempDirs.push(root);
    const pkgDir = path.join(root, "pkg");
    mkdirSync(pkgDir, { recursive: true });

    const snapshotRoot = path.join(pkgDir, "workspace-snapshot");
    const aliased = resolveSnapshotOutputPath(snapshotRoot, ".gitignore");
    mkdirSync(path.dirname(aliased), { recursive: true });
    writeFileSync(aliased, "node_modules/\n", "utf8");
    writeFileSync(
      path.join(snapshotRoot, "files", ".gitignore"),
      "node_modules/\n",
      "utf8",
    );
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "gitignore-alias-pack-check",
          version: "1.0.0",
          files: ["workspace-snapshot"],
        },
        null,
        2,
      ),
      "utf8",
    );

    execFileSync("npm", ["pack", "--pack-destination", root], {
      cwd: pkgDir,
      stdio: "pipe",
    });
    const tarball = path.join(root, "gitignore-alias-pack-check-1.0.0.tgz");
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    expect(listing).toContain(
      "package/workspace-snapshot/files/gitignore.snapshot",
    );
    expect(listing).not.toContain(
      "package/workspace-snapshot/files/.gitignore",
    );
  });
});

