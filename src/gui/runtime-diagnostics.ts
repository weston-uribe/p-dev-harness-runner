import type { RuntimeIntegrityResult } from "./runtime-integrity.js";

export function formatRuntimeDiagnostic(input: {
  failedCheck: string;
  reason: string;
  url?: string;
  integrity?: RuntimeIntegrityResult;
  snapshotId?: string;
  sourceRoot?: string;
  workspaceDir?: string;
  host?: string;
  port?: number;
  pid?: number;
  nextAction: string;
}): string {
  const lines = [
    "PDev GUI runtime diagnostic",
    `failed_check=${input.failedCheck}`,
    `reason=${input.reason}`,
  ];
  if (input.url) {
    lines.push(`url=${input.url}`);
  }
  if (input.integrity?.details) {
    for (const [key, value] of Object.entries(input.integrity.details)) {
      if (value !== undefined) {
        lines.push(`${key}=${String(value)}`);
      }
    }
  }
  if (input.snapshotId) {
    lines.push(`snapshot_id=${input.snapshotId}`);
  }
  if (input.sourceRoot) {
    lines.push(`source_root=${input.sourceRoot}`);
  }
  if (input.workspaceDir) {
    lines.push(`workspace_dir=${input.workspaceDir}`);
  }
  if (input.host !== undefined && input.port !== undefined) {
    lines.push(`listen=${input.host}:${input.port}`);
  }
  if (input.pid !== undefined) {
    lines.push(`pid=${input.pid}`);
  }
  lines.push(`next_action=${input.nextAction}`);
  return lines.join("\n");
}

export interface GuiDoctorReport {
  ok: boolean;
  runtimeModeExpected: "operator" | "developer";
  sourceRoot: string;
  workspaceDir: string | null;
  snapshotId: string | null;
  gitHead: string | null;
  contentFingerprint: string | null;
  completedRuntime: boolean;
  completionManifestPath: string | null;
  buildId: string | null;
  portListeners: number[];
  notes: string[];
}
