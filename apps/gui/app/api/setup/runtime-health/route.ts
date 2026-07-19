import { NextResponse } from "next/server";
import path from "node:path";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";

export const dynamic = "force-dynamic";

/**
 * Safe runtime identity for launcher integrity checks.
 * Never returns secrets or environment contents.
 */
export async function GET() {
  const workspaceDir = resolveHarnessWorkspaceDir();
  const sourceRoot =
    process.env.HARNESS_REPO_ROOT?.trim() ||
    process.env.P_DEV_PACKAGE_ROOT?.trim() ||
    null;
  const snapshotId = process.env.P_DEV_SNAPSHOT_ID?.trim() || null;
  const buildId = process.env.P_DEV_BUILD_ID?.trim() || null;
  const runtimeMode =
    process.env.P_DEV_RUNTIME_MODE?.trim() ||
    (process.env.P_DEV_DIST_DIR?.trim() ? "operator" : "developer");

  return NextResponse.json({
    ok: true,
    runtimeMode,
    snapshotId,
    buildId,
    sourceRoot: sourceRoot ? path.resolve(sourceRoot) : null,
    workspaceDir: path.resolve(workspaceDir),
    pid: process.pid,
  });
}
