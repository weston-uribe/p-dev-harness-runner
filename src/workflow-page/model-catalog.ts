import type { HarnessConfig } from "../config/types.js";
import type { CatalogLoadState, WorkflowModelCatalogEntry } from "./types.js";
import {
  buildCatalogUnavailableEntry,
  normalizeCursorModelCatalog,
  type RawCursorModel,
} from "./model-catalog-utils.js";

export {
  buildCatalogUnavailableEntry,
  buildModelCatalogFingerprint,
  normalizeCursorModelCatalog,
} from "./model-catalog-utils.js";
export { lookupModelInCatalog } from "./model-catalog-lookup.js";

export const WORKFLOW_MODEL_POLICY_NOTE =
  "Planner and builder model selections are saved to harness.config.json roleModels and affect runtime agents.";

export interface ModelCatalogLoadResult {
  catalog: WorkflowModelCatalogEntry[];
  loadState: CatalogLoadState;
}

export async function fetchLiveCursorModelCatalog(
  apiKey: string,
): Promise<ModelCatalogLoadResult> {
  const fetchedAt = new Date().toISOString();
  try {
    const { Cursor } = await import("@cursor/sdk");
    const models = (await Cursor.models.list({
      apiKey: apiKey.trim(),
    })) as RawCursorModel[];
    return {
      catalog: normalizeCursorModelCatalog(models, "cursor-live", fetchedAt),
      loadState: "loaded",
    };
  } catch {
    return {
      catalog: buildCatalogUnavailableEntry("cursor-live"),
      loadState: "unavailable",
    };
  }
}

export function emptyHarnessConfig(): HarnessConfig {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "target-app",
        targetRepo: "https://github.com/weston-uribe/example-target-app",
        baseBranch: "main",
        productionBranch: "main",
      },
    ],
    allowedTargetRepos: ["https://github.com/weston-uribe/example-target-app"],
  };
}
