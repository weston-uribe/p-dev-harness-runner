import {
  CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES,
  isCanonicalDispatchTriggerStatusName,
} from "../workflow/canonical-product-development-workflow.js";

/**
 * Linear statuses that should trigger a GitHub repository_dispatch.
 * Derived from the canonical product-development workflow descriptor.
 */
export const DISPATCH_TRIGGER_STATUSES = CANONICAL_DISPATCH_TRIGGER_STATUS_NAMES;

export type DispatchTriggerStatus = (typeof DISPATCH_TRIGGER_STATUSES)[number];

export function isDispatchTriggerStatus(
  status: string | null | undefined,
): status is DispatchTriggerStatus {
  return isCanonicalDispatchTriggerStatusName(status ?? "");
}
