import type { CanonicalStatusKey } from "@harness/workflow/canonical-product-development-workflow";
import type { CanonicalValidationViolation } from "@harness/workflow/canonical-workflow-validation";
import type { WorkflowBootstrapPayload } from "@harness/workflow-page/types";

export function isIgnorableStatusViolation(
  violation: CanonicalValidationViolation,
): boolean {
  if (violation.statusKey === "duplicate" && violation.kind === "missing-status") {
    return true;
  }
  return false;
}

export function getBlockingStatusViolations(
  violations: CanonicalValidationViolation[],
): CanonicalValidationViolation[] {
  return violations.filter(
    (violation) => violation.statusKey && !isIgnorableStatusViolation(violation),
  );
}

export function getViolationForStatus(
  violations: CanonicalValidationViolation[],
  statusKey: CanonicalStatusKey,
): CanonicalValidationViolation | undefined {
  return getBlockingStatusViolations(violations).find(
    (violation) => violation.statusKey === statusKey,
  );
}

export function countUnhealthyStatuses(
  violations: CanonicalValidationViolation[],
): number {
  const keys = new Set(
    getBlockingStatusViolations(violations)
      .map((violation) => violation.statusKey)
      .filter(Boolean),
  );
  return keys.size;
}

export function isWorkflowGloballyHealthy(
  bootstrap: WorkflowBootstrapPayload,
): boolean {
  const { healthState, violations } = bootstrap.canonicalWorkflow;
  if (healthState === "linear-unavailable") {
    return false;
  }
  if (healthState === "healthy") {
    return true;
  }
  return countUnhealthyStatuses(violations) === 0;
}
