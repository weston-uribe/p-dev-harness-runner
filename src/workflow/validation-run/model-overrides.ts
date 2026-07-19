/**
 * Apply issue-scoped validation-run modelSelections onto harness config
 * without mutating shared roleModels defaults on disk.
 */

import type { HarnessConfig } from "../../config/types.js";
import type { RoleModelsConfig } from "../../config/role-models.js";
import type { ValidationRunSnapshot } from "./types.js";

export function applyValidationRunModelSelections(
  config: HarnessConfig,
  snapshot: ValidationRunSnapshot | null | undefined,
): HarnessConfig {
  if (!snapshot) return config;
  const selections = snapshot.modelSelections ?? {};
  const next: RoleModelsConfig = { ...(config.roleModels ?? {}) };
  let changed = false;
  for (const role of ["planReviewer", "codeReviewer", "codeReviser"] as const) {
    const selection = selections[role];
    if (selection?.id) {
      next[role] = {
        id: selection.id,
        ...(selection.params?.length ? { params: [...selection.params] } : {}),
      };
      changed = true;
    }
  }
  if (!changed) return config;
  return { ...config, roleModels: next };
}
