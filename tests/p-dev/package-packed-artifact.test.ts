import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const packageDir = path.join(repoRoot, "packages", "p-dev");
const packagePackLockPath = path.join(os.tmpdir(), "p-dev-package-pack.lockdir");
let tarballPath = "";

const GENERATED_PACKAGE_OUTPUT_PREFIXES = [
  "packages/p-dev/bin/",
  "packages/p-dev/dist/",
  "packages/p-dev/gui/",
  "packages/p-dev/templates/",
  "packages/p-dev/workspace-snapshot/",
] as const;

function isIgnorableDirtyPackagePath(filePath: string): boolean {
  return GENERATED_PACKAGE_OUTPUT_PREFIXES.some((prefix) =>
    filePath.startsWith(prefix),
  );
}

function isCleanEnoughForPackagePack(): boolean {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .every((line) => isIgnorableDirtyPackagePath(line.slice(3).trim()));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquirePackagePackLock(): () => void {
  while (true) {
    try {
      mkdirSync(packagePackLockPath);
      return () => rmSync(packagePackLockPath, { recursive: true, force: true });
    } catch {
      sleepSync(250);
    }
  }
}

function tarballSourceCommit(): string | null {
  if (!existsSync(tarballPath)) {
    return null;
  }
  try {
    const raw = execFileSync(
      "tar",
      ["-xOf", tarballPath, "package/workspace-snapshot/manifest.json"],
      { encoding: "utf8" },
    );
    return (JSON.parse(raw) as { sourceCommit?: string }).sourceCommit ?? null;
  } catch {
    return null;
  }
}

function packCurrentTarballIfNeeded(): void {
  const packageJson = JSON.parse(
    readFileSync(path.join(packageDir, "package.json"), "utf8"),
  ) as { version: string };
  tarballPath = path.join(packageDir, `p-dev-harness-${packageJson.version}.tgz`);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const releaseLock = acquirePackagePackLock();
  try {
    if (tarballSourceCommit() === head) {
      return;
    }
    execFileSync("npm", ["run", "package:p-dev:pack"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  } finally {
    releaseLock();
  }
}

describe.skipIf(!isCleanEnoughForPackagePack())("p-dev packed artifact", () => {
  beforeAll(() => {
    packCurrentTarballIfNeeded();
  }, 180_000);

  afterAll(() => {
    // keep tarball for PR validation evidence
  });

  it("includes MIT LICENSE in the packed tarball", () => {
    expect(existsSync(tarballPath)).toBe(true);
    const listing = execFileSync("tar", ["-tzf", tarballPath], {
      encoding: "utf8",
    });
    expect(listing).toContain("package/LICENSE");
    expect(listing).toContain("package/README.md");
    expect(listing).toContain("package/workspace-snapshot/manifest.json");
    expect(listing).toMatch(/package\/workspace-snapshot\/files\/src\//);
    expect(listing).toContain(
      "package/workspace-snapshot/files/apps/gui/app/workflow/page.tsx",
    );
    expect(listing).toContain(
      "package/workspace-snapshot/files/apps/gui/lib/workflow-server.ts",
    );
    expect(listing).toContain(
      "package/workspace-snapshot/files/apps/gui/components/workflow/workflow-page-client.tsx",
    );
    expect(listing).not.toContain("operations-canvas.tsx");
    expect(listing).not.toMatch(/@xyflow\/react/);
    expect(listing).not.toMatch(/\.env\.local/);
    expect(listing).not.toMatch(/config\.local\.json/);
    expect(listing).not.toMatch(/operations-workflow-draft\.local\.json/);
    expect(listing).not.toMatch(/\.tgz$/);
  });

  it("declares the current package version in packed package.json", () => {
    const raw = execFileSync(
      "tar",
      ["-xOf", tarballPath, "package/package.json"],
      { encoding: "utf8" },
    );
    const manifest = JSON.parse(raw) as {
      version: string;
      private?: boolean;
      dependencies: Record<string, string>;
    };
    const sourcePackageJson = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    ) as { version: string };
    expect(manifest.version).toBe(sourcePackageJson.version);
    expect(manifest.private).toBeUndefined();
    expect(manifest.dependencies["posthog-node"]).toBeDefined();
  });

  it("ships a valid workspace snapshot manifest", () => {
    const raw = execFileSync(
      "tar",
      ["-xOf", tarballPath, "package/workspace-snapshot/manifest.json"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(raw) as {
      snapshotContentId: string;
      snapshotSha256: string;
      fileCount: number;
      files: unknown[];
    };
    expect(parsed.snapshotContentId).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.fileCount).toBeGreaterThan(100);
    expect(parsed.files.length).toBe(parsed.fileCount);
  });

  it("ships npm README describing embedded snapshot provisioning for 0.4.0", () => {
    const raw = execFileSync("tar", ["-xOf", tarballPath, "package/README.md"], {
      encoding: "utf8",
    });
    expect(raw).toContain("p-dev-harness@0.4.0");
    expect(raw).toContain("immutable embedded workspace snapshot");
    expect(raw).not.toMatch(/public template.*provisioning source/i);
    expect(raw).not.toMatch(/template must remain/i);
    expect(raw).toContain("frozen legacy compatibility artifact");
    expect(raw).toMatch(/observability|telemetry/i);
  });

  it("includes public observability config without privileged credentials", () => {
    const listing = execFileSync("tar", ["-tzf", tarballPath], {
      encoding: "utf8",
    });
    expect(listing).toContain("package/observability.public.json");
    expect(listing).not.toMatch(/observability\.local\.json/);
    const raw = execFileSync(
      "tar",
      ["-xOf", tarballPath, "package/observability.public.json"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.observabilitySchemaVersion).toBe(1);
    expect(typeof parsed.sentryPublicDsn).toBe("string");
    expect((parsed.sentryPublicDsn as string).length).toBeGreaterThan(0);
    expect(typeof parsed.posthogProjectToken).toBe("string");
    expect((parsed.posthogProjectToken as string).length).toBeGreaterThan(0);
    expect((parsed.posthogProjectToken as string).startsWith("phc_")).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/phx_/i);
    expect(JSON.stringify(parsed)).not.toMatch(/authToken/i);
    expect(JSON.stringify(parsed)).not.toMatch(/\.harness/);
  });

  it("includes Builder thread continuity modules in the workspace snapshot", () => {
    const listing = execFileSync("tar", ["-tzf", tarballPath], {
      encoding: "utf8",
    });
    expect(listing).toContain(
      "package/workspace-snapshot/files/src/runner/builder-thread-lineage.ts",
    );
    expect(listing).toContain(
      "package/workspace-snapshot/files/src/runner/builder-thread-acquire.ts",
    );
    expect(listing).toContain(
      "package/workspace-snapshot/files/src/cursor/builder-resume-errors.ts",
    );
  });

  it("records tarball metadata for release evidence", () => {
    const bytes = readFileSync(tarballPath).byteLength;
    const sha1 = execFileSync("shasum", ["-a", "1", tarballPath], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/)[0];
    const sha256 = execFileSync("shasum", ["-a", "256", tarballPath], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/)[0];

    expect(bytes).toBeGreaterThan(0);
    expect(sha1).toMatch(/^[a-f0-9]{40}$/);
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
