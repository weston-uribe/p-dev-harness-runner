import type { WorkflowModelCatalogEntry } from "../types.js";

/**
 * Verified Cursor.models.list() capture was not available in this implementation
 * environment (no CURSOR_API_KEY). Fixture mode uses this deterministic snapshot
 * with the models confirmed in prior fixture seeds only.
 */
export const FIXTURE_MODEL_CATALOG_CAPTURED_AT = "2026-01-01T00:00:00.000Z";

export const FIXTURE_MODEL_CATALOG_LIMITATION =
  "Multi-model fixture catalog requires a verified Cursor.models.list() capture. Only models from existing fixture seeds are included until capture is available.";

export function getFixtureModelCatalog(): WorkflowModelCatalogEntry[] {
  return FIXTURE_MODEL_CATALOG.map((entry) => ({ ...entry }));
}

const FIXTURE_MODEL_CATALOG: WorkflowModelCatalogEntry[] = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    availability: "available",
    supportedParameters: [
      {
        id: "fast",
        label: "Fast mode",
        type: "boolean",
        allowedValues: ["true", "false"],
        // Cursor provider default when omitted is Fast.
        defaultValue: "true",
      },
    ],
    fetchedAt: FIXTURE_MODEL_CATALOG_CAPTURED_AT,
    source: "fixture",
    fastModeAvailable: true,
    providerDefaultParams: [{ id: "fast", value: "true" }],
    harnessDefaultParams: [{ id: "fast", value: "false" }],
  },
  {
    id: "fixture-no-fast-model",
    displayName: "Fixture No-Fast Model",
    availability: "available",
    supportedParameters: [],
    fetchedAt: FIXTURE_MODEL_CATALOG_CAPTURED_AT,
    source: "fixture",
    fastModeAvailable: false,
    providerDefaultParams: [],
    harnessDefaultParams: [],
  },
];
