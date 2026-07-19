import { parseProductMarkerJson } from "./product-marker.js";

export type ProductInitializationState =
  | "initialized"
  | "uninitialized"
  | "missing_marker"
  | "invalid_marker";

export interface ResolvedProductInitialization {
  state: ProductInitializationState;
  hasApprovedArchitecture: boolean;
  reason?: string;
}

export function markerHasApprovedArchitecture(marker: {
  approvedArchitecture?: {
    platformRuntime?: string;
    languageFramework?: string;
  };
}): boolean {
  const architecture = marker.approvedArchitecture;
  return Boolean(
    architecture?.platformRuntime?.trim() && architecture?.languageFramework?.trim(),
  );
}

export function resolveProductInitializationState(
  markerContent: string | null,
): ResolvedProductInitialization {
  if (markerContent === null) {
    return {
      state: "missing_marker",
      hasApprovedArchitecture: false,
      reason: "Product marker not found on development branch.",
    };
  }

  const parsed = parseProductMarkerJson(markerContent);
  if (!parsed.ok) {
    return {
      state: "invalid_marker",
      hasApprovedArchitecture: false,
      reason: parsed.reason,
    };
  }

  const hasApprovedArchitecture = markerHasApprovedArchitecture(parsed.marker);
  if (parsed.marker.initializationStatus === "initialized") {
    return {
      state: "initialized",
      hasApprovedArchitecture: hasApprovedArchitecture || true,
    };
  }

  return {
    state: "uninitialized",
    hasApprovedArchitecture,
  };
}

export function blocksDirectImplementationForInitialization(
  initialization: ResolvedProductInitialization,
): boolean {
  return initialization.state === "uninitialized";
}
