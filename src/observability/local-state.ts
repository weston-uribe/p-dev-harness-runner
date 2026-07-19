import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { OBSERVABILITY_LOCAL_FILE } from "./constants.js";
import type { ConsentPreference, ObservabilityLocalState } from "./types.js";

export function resolveObservabilityLocalStatePath(
  workspaceDir: string,
): string {
  return path.join(workspaceDir, OBSERVABILITY_LOCAL_FILE);
}

function createDefaultState(now = new Date().toISOString()): ObservabilityLocalState {
  return {
    schemaVersion: 1,
    analyticsPreference: null,
    errorReportingPreference: null,
    disclosureShown: false,
    createdAt: now,
    updatedAt: now,
  };
}

function parseState(raw: string): ObservabilityLocalState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ObservabilityLocalState>;
    if (parsed.schemaVersion !== 1) {
      return null;
    }
    return {
      schemaVersion: 1,
      installationId:
        typeof parsed.installationId === "string"
          ? parsed.installationId
          : undefined,
      analyticsPreference: normalizePreference(parsed.analyticsPreference),
      errorReportingPreference: normalizePreference(
        parsed.errorReportingPreference,
      ),
      disclosureShown: parsed.disclosureShown === true,
      createdAt:
        typeof parsed.createdAt === "string"
          ? parsed.createdAt
          : new Date().toISOString(),
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function normalizePreference(value: unknown): ConsentPreference {
  if (value === "enabled" || value === "disabled") {
    return value;
  }
  return null;
}

export async function readObservabilityLocalState(
  workspaceDir: string,
): Promise<ObservabilityLocalState> {
  const filePath = resolveObservabilityLocalStatePath(workspaceDir);
  try {
    const raw = await readFile(filePath, "utf8");
    return parseState(raw) ?? createDefaultState();
  } catch {
    return createDefaultState();
  }
}

export async function writeObservabilityLocalState(
  workspaceDir: string,
  state: ObservabilityLocalState,
): Promise<void> {
  const filePath = resolveObservabilityLocalStatePath(workspaceDir);
  const harnessDir = path.dirname(filePath);
  await mkdir(harnessDir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

export async function resetObservabilityLocalState(
  workspaceDir: string,
): Promise<void> {
  const filePath = resolveObservabilityLocalStatePath(workspaceDir);
  try {
    await rm(filePath, { force: true });
  } catch {
    // ignore missing file
  }
}

export interface UpdateObservabilityPreferencesInput {
  analyticsPreference?: ConsentPreference;
  errorReportingPreference?: ConsentPreference;
  disclosureShown?: boolean;
  installationId?: string | null;
}

export async function updateObservabilityPreferences(
  workspaceDir: string,
  input: UpdateObservabilityPreferencesInput,
): Promise<ObservabilityLocalState> {
  const current = await readObservabilityLocalState(workspaceDir);
  const now = new Date().toISOString();
  const next: ObservabilityLocalState = {
    ...current,
    updatedAt: now,
  };

  if (input.analyticsPreference !== undefined) {
    next.analyticsPreference = input.analyticsPreference;
  }
  if (input.errorReportingPreference !== undefined) {
    next.errorReportingPreference = input.errorReportingPreference;
  }
  if (input.disclosureShown !== undefined) {
    next.disclosureShown = input.disclosureShown;
  }
  if (input.installationId === null) {
    delete next.installationId;
  } else if (typeof input.installationId === "string") {
    next.installationId = input.installationId;
  }

  await writeObservabilityLocalState(workspaceDir, next);
  return next;
}

export function isFirstLaunchForPDevHome(
  state: ObservabilityLocalState,
): boolean {
  return (
    state.analyticsPreference === null &&
    state.errorReportingPreference === null &&
    !state.disclosureShown
  );
}
