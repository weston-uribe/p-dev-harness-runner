import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRuntimeProvenancePath } from "../artifacts/paths.js";
import { HARNESS_MANAGED_REPO_MARKER_FILE } from "../setup/harness-managed-repo-marker.js";

export const RUNTIME_PROVENANCE_SCHEMA_VERSION = "runtime-provenance-v1" as const;

export type RuntimeProvenanceSource =
  | "managed_marker_and_github_env"
  | "local_environment";

export interface RuntimeProvenance {
  harnessSourceCommit: string | null;
  managedRunnerCommit: string | null;
  provenanceSchemaVersion: typeof RUNTIME_PROVENANCE_SCHEMA_VERSION;
  capturedAt: string;
  provenanceSource: RuntimeProvenanceSource;
}

export class RuntimeProvenanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeProvenanceConflictError";
  }
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function isCommitSha(value: string | null | undefined): value is string {
  return typeof value === "string" && COMMIT_SHA_PATTERN.test(value.trim());
}

export function parseManagedMarkerSourceCommit(
  markerJson: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(markerJson) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const snapshot = (parsed as Record<string, unknown>)
    .createdFromPackageSnapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  const sourceCommit = (snapshot as Record<string, unknown>).sourceCommit;
  if (typeof sourceCommit !== "string") {
    return null;
  }
  const trimmed = sourceCommit.trim();
  return isCommitSha(trimmed) ? trimmed.toLowerCase() : null;
}

export async function readManagedMarkerSourceCommitFromFile(
  markerPath: string,
): Promise<string | null> {
  try {
    const raw = await readFile(markerPath, "utf8");
    return parseManagedMarkerSourceCommit(raw);
  } catch {
    return null;
  }
}

export function resolveRuntimeProvenanceFromProcessEnv(options?: {
  now?: () => string;
  markerPath?: string;
}): RuntimeProvenance {
  const harnessFromEnv = process.env.HARNESS_SOURCE_COMMIT?.trim() || null;
  const managedFromEnv =
    process.env.MANAGED_RUNNER_COMMIT?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    null;

  const harnessSourceCommit = isCommitSha(harnessFromEnv)
    ? harnessFromEnv.toLowerCase()
    : null;
  const managedRunnerCommit = isCommitSha(managedFromEnv)
    ? managedFromEnv.toLowerCase()
    : null;

  const isManaged =
    Boolean(process.env.GITHUB_ACTIONS) &&
    (Boolean(harnessSourceCommit) || Boolean(process.env.HARNESS_SOURCE_COMMIT));

  return {
    harnessSourceCommit,
    managedRunnerCommit,
    provenanceSchemaVersion: RUNTIME_PROVENANCE_SCHEMA_VERSION,
    capturedAt: (options?.now ?? (() => new Date().toISOString()))(),
    provenanceSource: isManaged
      ? "managed_marker_and_github_env"
      : "local_environment",
  };
}

export async function resolveRuntimeProvenanceForLocalRun(options?: {
  workspaceRoot?: string;
  now?: () => string;
}): Promise<RuntimeProvenance> {
  const fromEnv = resolveRuntimeProvenanceFromProcessEnv({ now: options?.now });
  if (fromEnv.harnessSourceCommit) {
    return fromEnv;
  }

  const markerPath = path.join(
    options?.workspaceRoot ?? process.cwd(),
    HARNESS_MANAGED_REPO_MARKER_FILE,
  );
  const harnessSourceCommit =
    await readManagedMarkerSourceCommitFromFile(markerPath);

  return {
    harnessSourceCommit,
    managedRunnerCommit: fromEnv.managedRunnerCommit,
    provenanceSchemaVersion: RUNTIME_PROVENANCE_SCHEMA_VERSION,
    capturedAt: fromEnv.capturedAt,
    provenanceSource: "local_environment",
  };
}

function provenanceRecordsEqual(
  a: RuntimeProvenance,
  b: RuntimeProvenance,
): boolean {
  return (
    a.harnessSourceCommit === b.harnessSourceCommit &&
    a.managedRunnerCommit === b.managedRunnerCommit &&
    a.provenanceSchemaVersion === b.provenanceSchemaVersion &&
    a.provenanceSource === b.provenanceSource
  );
}

export async function readRuntimeProvenance(
  runDirectory: string,
): Promise<RuntimeProvenance | null> {
  try {
    const raw = await readFile(getRuntimeProvenancePath(runDirectory), "utf8");
    const parsed = JSON.parse(raw) as RuntimeProvenance;
    if (parsed.provenanceSchemaVersion !== RUNTIME_PROVENANCE_SCHEMA_VERSION) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function ensureRuntimeProvenanceArtifact(
  runDirectory: string,
  provenance: RuntimeProvenance,
): Promise<void> {
  const target = getRuntimeProvenancePath(runDirectory);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const existing = await readRuntimeProvenance(runDirectory);
    if (existing) {
      if (!provenanceRecordsEqual(existing, provenance)) {
        throw new RuntimeProvenanceConflictError(
          `runtime-provenance.json already exists with conflicting values in ${runDirectory}`,
        );
      }
      return;
    }
    await writeFile(target, `${JSON.stringify(provenance, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (
      error instanceof RuntimeProvenanceConflictError ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
    const existing = await readRuntimeProvenance(runDirectory);
    if (existing && !provenanceRecordsEqual(existing, provenance)) {
      throw new RuntimeProvenanceConflictError(
        `runtime-provenance.json already exists with conflicting values in ${runDirectory}`,
      );
    }
  }
}

export async function captureRuntimeProvenanceAtRunStart(
  runDirectory: string,
  options?: { workspaceRoot?: string; now?: () => string },
): Promise<RuntimeProvenance> {
  const provenance = await resolveRuntimeProvenanceForLocalRun(options);
  await ensureRuntimeProvenanceArtifact(runDirectory, provenance);
  return provenance;
}

/** Allowlisted metadata fields for traces and telemetry. */
export function runtimeProvenanceMetadata(
  provenance: RuntimeProvenance,
): Record<string, string | null> {
  return {
    harnessSourceCommit: provenance.harnessSourceCommit,
    managedRunnerCommit: provenance.managedRunnerCommit,
    harnessReleaseSha: provenance.managedRunnerCommit,
  };
}
