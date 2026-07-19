import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("target-workflow-pr-card guided flow", () => {
  it("allows confirm without preview and runs internal preflight on apply", () => {
    const source = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/target-workflow-pr-card.tsx"),
      "utf8",
    );
    const confirmationSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/remote-action-confirmation.tsx"),
      "utf8",
    );
    const disclosureSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/review-workflow-changes-disclosure.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("ReviewWorkflowChangesDisclosure");
    expect(source).toContain("previewIsCurrent && preview ? preview : await runPreview()");
    expect(source).toMatch(
      /variant === "guided" \?[\s\S]*disabled=\{[\s\S]*!confirmed[\s\S]*blockedByUpstream/,
    );
    expect(source).toContain("ReviewWorkflowChangesDisclosure");
    expect(disclosureSource).toContain(
      "Review planned workflow changes (optional)",
    );
    expect(confirmationSource).toContain(
      "Preflight runs automatically before apply when you skip preview.",
    );
    expect(confirmationSource).not.toContain(
      "I reviewed the workflow preview and want to create or update the workflow install PR.",
    );
  });
});

describe("guided workflow install progress panel", () => {
  it("hides Open GitHub details in guided flow", () => {
    const panelSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/workflow-install-pending-panel.tsx",
      ),
      "utf8",
    );
    const guidedSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-target-workflow-card.tsx",
      ),
      "utf8",
    );

    expect(panelSource).toContain('variant === "advanced"');
    expect(panelSource).toContain("WORKFLOW_INSTALL_UI_PHASE_LABELS");
    expect(panelSource).toContain("GuidedOperationPanel");
    expect(guidedSource).toContain('variant="guided"');
    expect(guidedSource).toContain("isNewerFinalization");
    expect(guidedSource).toContain("pollGenerationRef.current += 1");
    expect(guidedSource).toContain("WORKFLOW_INSTALL_MAX_TRANSIENT_RETRIES");
  });
});
