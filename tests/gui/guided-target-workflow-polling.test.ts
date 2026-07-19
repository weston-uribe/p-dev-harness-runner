import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("guided target workflow polling UX", () => {
  it("does not silently stop polling with an empty catch", async () => {
    const source = await readFile(
      path.join(
        ROOT,
        "apps/gui/components/custom/guided-target-workflow-card.tsx",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/catch\s*\{\s*break;\s*\}/);
    expect(source).toContain("WORKFLOW_INSTALL_MAX_TRANSIENT_RETRIES");
    expect(source).toContain("Temporarily unable to refresh GitHub status.");
    expect(source).toContain("retryable");
    expect(source).toContain("retryAfterMs");
    expect(source).toContain("lockContended");
    expect(source).toContain("onStepCompleted");
  });

  it("drives guided phases from server phase labels", async () => {
    const panel = await readFile(
      path.join(
        ROOT,
        "apps/gui/components/custom/workflow-install-pending-panel.tsx",
      ),
      "utf8",
    );
    expect(panel).toContain("WORKFLOW_INSTALL_UI_PHASES");
    expect(panel).toContain("GuidedOperationPanel");
    expect(panel).toContain("GuidedStepSuccessPanel");
    expect(panel).toContain("Continue to finish setup");
  });
});
