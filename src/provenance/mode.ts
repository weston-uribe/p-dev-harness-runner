import { CursorProvenanceError } from "./errors.js";

export const PROVENANCE_MODE_ENV = "P_DEV_CURSOR_PROVENANCE_MODE";

export type ProvenanceWriterMode = "disabled" | "shadow" | "required";

export function resolveProvenanceMode(
  env: Record<string, string | undefined> = process.env,
): ProvenanceWriterMode {
  const raw = env[PROVENANCE_MODE_ENV]?.trim().toLowerCase();
  if (!raw || raw === "disabled") {
    return "disabled";
  }
  if (raw === "shadow") {
    return "shadow";
  }
  if (raw === "required") {
    return "required";
  }
  throw new CursorProvenanceError(
    "cursor_provenance_config_invalid",
    `Invalid ${PROVENANCE_MODE_ENV}; expected disabled|shadow|required.`,
  );
}

export function modeBlocksOnProvenanceFailure(
  mode: ProvenanceWriterMode,
): boolean {
  return mode === "required";
}

export function modeWritesProvenance(mode: ProvenanceWriterMode): boolean {
  return mode === "shadow" || mode === "required";
}

export function modeEligibleForCoverageEpoch(
  mode: ProvenanceWriterMode,
): boolean {
  return mode === "required";
}
