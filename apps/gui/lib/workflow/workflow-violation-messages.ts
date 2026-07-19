import type { CanonicalValidationViolation } from "@harness/workflow/canonical-workflow-validation";
import { formatLinearCategoryLabel } from "@harness/setup/linear-category-labels";
import { lookupCanonicalStatus } from "@harness/workflow/canonical-product-development-workflow";

export interface FormattedWorkflowViolationMessage {
  primary: string;
  body?: string;
  diagnostic?: string[];
}

function parseWrongCategoryFromMessage(message: string): {
  expected?: string;
  actual?: string;
} {
  const match = message.match(
    /expected "([^"]+)", got "([^"]+)"/,
  );
  if (!match) {
    return {};
  }
  return { expected: match[1], actual: match[2] };
}

export function formatWorkflowViolationMessage(
  violation: CanonicalValidationViolation,
): FormattedWorkflowViolationMessage {
  if (
    violation.statusKey === "needs-revision" &&
    violation.kind === "wrong-category"
  ) {
    const parsed = parseWrongCategoryFromMessage(violation.message);
    const expectedCategory =
      parsed.expected ??
      lookupCanonicalStatus("needs-revision")?.category ??
      "unstarted";
    const actualCategory = parsed.actual ?? "started";

    return {
      primary: "Needs Revision is configured as active work in Linear.",
      body: "Needs Revision should mean work is waiting to begin. Active revision work belongs in Revising.",
      diagnostic: [
        `Expected Linear category: ${formatLinearCategoryLabel(expectedCategory)}`,
        `Current Linear category: ${formatLinearCategoryLabel(actualCategory)}`,
      ],
    };
  }

  return { primary: violation.message };
}
