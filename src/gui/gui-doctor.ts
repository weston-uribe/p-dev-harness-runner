#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPortListeners } from "./existing-server.js";
import {
  isCompletedOperatorRuntime,
  readCompletionManifest,
} from "./runtime-publish.js";
import {
  resolveCompletionManifestPath,
  resolveFinalRuntimeDir,
  resolveOperatorRuntimeRoot,
} from "./runtime-paths.js";
import { computeRuntimeSnapshotIdentity } from "./runtime-snapshot.js";
import type { GuiDoctorReport } from "./runtime-diagnostics.js";
import { DEFAULT_GUI_PORT } from "./port.js";

export async function collectGuiDoctorReport(input: {
  sourceRoot: string;
  workspaceDir?: string | null;
  port?: number;
}): Promise<GuiDoctorReport> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const snapshot = await computeRuntimeSnapshotIdentity(sourceRoot);
  const runtimeDir = resolveFinalRuntimeDir(sourceRoot, snapshot.snapshotId);
  const completed = await isCompletedOperatorRuntime({
    runtimeDir,
    snapshot,
  });
  const manifest = completed ? await readCompletionManifest(runtimeDir) : null;
  const port = input.port ?? DEFAULT_GUI_PORT;
  const portListeners = await listPortListeners(port);
  const notes: string[] = [
    "Operator commands: p-dev, npm start (next build + next start, immutable runtime).",
    "Developer commands: npm run dev, npm run gui:dev (next dev, mutable .next).",
    `Operator runtime root: ${resolveOperatorRuntimeRoot(sourceRoot)}`,
  ];
  if (!completed) {
    notes.push(
      "No completed operator runtime for current snapshot (missing or incomplete completion manifest).",
    );
  }

  return {
    ok: completed,
    runtimeModeExpected: "operator",
    sourceRoot,
    workspaceDir: input.workspaceDir ? path.resolve(input.workspaceDir) : null,
    snapshotId: snapshot.snapshotId,
    gitHead: snapshot.gitHead,
    contentFingerprint: snapshot.contentFingerprint,
    completedRuntime: completed,
    completionManifestPath: completed
      ? resolveCompletionManifestPath(runtimeDir)
      : null,
    buildId: manifest?.buildId ?? null,
    portListeners,
    notes,
  };
}

export function formatGuiDoctorReport(report: GuiDoctorReport): string {
  return [
    "PDev GUI doctor (safe diagnostics — no secrets)",
    `ok=${report.ok}`,
    `source_root=${report.sourceRoot}`,
    `workspace_dir=${report.workspaceDir ?? "(unset)"}`,
    `snapshot_id=${report.snapshotId ?? "(none)"}`,
    `git_head=${report.gitHead ?? "(none)"}`,
    `content_fingerprint=${report.contentFingerprint ?? "(none)"}`,
    `completed_runtime=${report.completedRuntime}`,
    `completion_manifest=${report.completionManifestPath ?? "(none)"}`,
    `build_id=${report.buildId ?? "(none)"}`,
    `port_listeners=${report.portListeners.join(",") || "(none)"}`,
    ...report.notes.map((note) => `note=${note}`),
  ].join("\n");
}

async function main(): Promise<void> {
  const sourceRoot =
    process.env.HARNESS_REPO_ROOT?.trim() ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const workspaceDir = process.env.P_DEV_HOME?.trim() || null;
  const report = await collectGuiDoctorReport({ sourceRoot, workspaceDir });
  console.log(formatGuiDoctorReport(report));
  process.exitCode = report.ok ? 0 : 1;
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(entryPath)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`harness:gui:doctor failed: ${message}`);
    process.exit(1);
  });
}
