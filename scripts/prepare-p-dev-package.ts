import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateWorkspaceSnapshot } from "../src/p-dev/workspace-snapshot-generator.js";
import { assertCleanGitSource } from "../src/p-dev/workspace-snapshot-git.js";
import { resolveObservabilityPublicConfigForPrepare } from "../src/observability/package-config.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageDir = path.join(repoRoot, "packages", "p-dev");
const guiSourceDir = path.join(repoRoot, "apps", "gui");
const distDir = path.join(repoRoot, "dist");

async function run(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, {
    cwd: repoRoot,
    env: process.env,
  });
}

async function copyNextBuildOutput(
  sourceNextDir: string,
  destinationNextDir: string,
): Promise<void> {
  await mkdir(destinationNextDir, { recursive: true });
  const entries = await readdir(sourceNextDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === "cache") {
      continue;
    }

    await cp(
      path.join(sourceNextDir, entry.name),
      path.join(destinationNextDir, entry.name),
      { recursive: true, force: true },
    );
  }
}

async function copyIfExists(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const sourceCommit = await assertCleanGitSource(repoRoot, "HEAD", {
    requireHeadMatch: true,
    requireCleanWorkingTree: true,
  });

  console.log("Building harness TypeScript and Configure GUI…");
  await run("npm", ["run", "build"]);

  const generatedPaths = [
    path.join(packageDir, "bin"),
    path.join(packageDir, "dist"),
    path.join(packageDir, "gui"),
    path.join(packageDir, "templates"),
    path.join(packageDir, "workspace-snapshot"),
  ];

  for (const generatedPath of generatedPaths) {
    await rm(generatedPath, { recursive: true, force: true });
  }

  await mkdir(path.join(packageDir, "bin"), { recursive: true });
  await mkdir(path.join(packageDir, "gui"), { recursive: true });
  await mkdir(path.join(packageDir, "templates"), { recursive: true });
  await mkdir(path.join(packageDir, "templates", ".harness"), {
    recursive: true,
  });

  console.log("Copying launcher build output…");
  await copyIfExists(distDir, path.join(packageDir, "dist"));

  const binContents = `#!/usr/bin/env node
import "../dist/p-dev/main.js";
`;
  await writeFile(path.join(packageDir, "bin", "p-dev.js"), binContents, {
    mode: 0o755,
  });

  console.log("Copying Configure GUI runtime assets…");
  await copyNextBuildOutput(
    path.join(guiSourceDir, ".next"),
    path.join(packageDir, "gui", ".next"),
  );
  await copyIfExists(
    path.join(guiSourceDir, "public"),
    path.join(packageDir, "gui", "public"),
  );

  for (const fileName of ["postcss.config.mjs"]) {
    await copyIfExists(
      path.join(guiSourceDir, fileName),
      path.join(packageDir, "gui", fileName),
    );
  }

  await copyIfExists(
    path.join(packageDir, "gui.next.config.mjs"),
    path.join(packageDir, "gui", "next.config.mjs"),
  );

  console.log("Copying safe workspace templates…");
  await copyIfExists(
    path.join(repoRoot, ".env.example"),
    path.join(packageDir, "templates", ".env.example"),
  );
  await copyIfExists(
    path.join(repoRoot, ".harness", "config.example.json"),
    path.join(packageDir, "templates", ".harness", "config.example.json"),
  );

  console.log("Copying MIT license for npm publication…");
  await copyIfExists(
    path.join(repoRoot, "LICENSE"),
    path.join(packageDir, "LICENSE"),
  );

  console.log("Copying tracked public observability configuration…");
  const observabilityConfig = resolveObservabilityPublicConfigForPrepare(repoRoot);
  await writeFile(
    path.join(packageDir, "observability.public.json"),
    `${JSON.stringify(observabilityConfig, null, 2)}\n`,
    "utf8",
  );

  const packageJson = JSON.parse(
    await readFile(path.join(packageDir, "package.json"), "utf8"),
  ) as { version: string };
  const snapshotOutputDir = path.join(packageDir, "workspace-snapshot");
  console.log(
    `Generating immutable workspace snapshot from checked-out HEAD ${sourceCommit}…`,
  );
  const snapshot = await generateWorkspaceSnapshot({
    repoRoot,
    packageVersion: packageJson.version,
    sourceRef: "HEAD",
    outputDir: snapshotOutputDir,
  });
  if (snapshot.sourceCommit !== sourceCommit) {
    throw new Error(
      `Snapshot source commit mismatch (expected ${sourceCommit}, got ${snapshot.sourceCommit}).`,
    );
  }
  console.log(
    `Workspace snapshot ready (${snapshot.manifest.fileCount} files, source ${snapshot.sourceCommit.slice(0, 7)}, content ${snapshot.manifest.snapshotContentId.slice(0, 12)}…).`,
  );

  console.log(`Prepared p-dev package at packages/p-dev`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`prepare-p-dev-package failed: ${message}`);
  process.exit(1);
});
