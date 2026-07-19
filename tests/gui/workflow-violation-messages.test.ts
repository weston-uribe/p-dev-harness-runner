import { describe, expect, it } from "vitest";
import { formatWorkflowViolationMessage } from "../../apps/gui/lib/workflow/workflow-violation-messages.js";

describe("workflow-violation-messages", () => {
  it("explains queued versus active work for Needs Revision category mismatch", () => {
    const formatted = formatWorkflowViolationMessage({
      kind: "wrong-category",
      statusKey: "needs-revision",
      statusName: "Needs Revision",
      linearStatusId: "legacy-1",
      message:
        'Status "Needs Revision" has wrong category: expected "unstarted", got "started".',
    });

    expect(formatted.primary).toBe(
      "Needs Revision is configured as active work in Linear.",
    );
    expect(formatted.body).toBe(
      "Needs Revision should mean work is waiting to begin. Active revision work belongs in Revising.",
    );
    expect(formatted.diagnostic).toEqual([
      "Expected Linear category: Unstarted",
      "Current Linear category: Started",
    ]);
  });

  it("falls back to the raw violation message for other violations", () => {
    const formatted = formatWorkflowViolationMessage({
      kind: "missing-status",
      statusKey: "blocked",
      statusName: "Blocked",
      message: 'Missing canonical status "Blocked" (started).',
    });

    expect(formatted).toEqual({
      primary: 'Missing canonical status "Blocked" (started).',
    });
  });
});
