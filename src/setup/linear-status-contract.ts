import {
  CANONICAL_STATUSES,
  DEPRECATED_CANONICAL_STATUS_NAMES,
  getCanonicalDispatchTriggerStatusNames,
  getCreatableCanonicalStatuses,
  isCanonicalDispatchTriggerStatusName,
  lookupCanonicalStatusByName,
  type LinearWorkflowStateCategory,
} from "../workflow/canonical-product-development-workflow.js";

export type { LinearWorkflowStateCategory };

export interface RequiredWorkflowStatus {
  name: string;
  category: LinearWorkflowStateCategory;
  role:
    | "dispatch-trigger"
    | "transitional"
    | "human-gate"
    | "terminal"
    | "system-managed";
  creatable: boolean;
}

export const DEPRECATED_STATUS_NAMES = DEPRECATED_CANONICAL_STATUS_NAMES;

export const REQUIRED_WORKFLOW_STATUSES: readonly RequiredWorkflowStatus[] =
  CANONICAL_STATUSES.map((status) => ({
    name: status.name,
    category: status.category,
    role: status.role,
    creatable: status.creatable,
  }));

export function getDispatchTriggerStatuses(): readonly string[] {
  return getCanonicalDispatchTriggerStatusNames();
}

export function isDispatchTriggerStatusName(name: string): boolean {
  return isCanonicalDispatchTriggerStatusName(name);
}

export function requiredStatusNames(): string[] {
  return REQUIRED_WORKFLOW_STATUSES.map((status) => status.name);
}

export function requiredCreatableStatuses(): RequiredWorkflowStatus[] {
  return getCreatableCanonicalStatuses().map((status) => ({
    name: status.name,
    category: status.category,
    role: status.role,
    creatable: status.creatable,
  }));
}

export function lookupRequiredStatus(
  name: string,
): RequiredWorkflowStatus | undefined {
  const canonical = lookupCanonicalStatusByName(name);
  if (!canonical) {
    return undefined;
  }
  return {
    name: canonical.name,
    category: canonical.category,
    role: canonical.role,
    creatable: canonical.creatable,
  };
}
