import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readLinearEditor(): string {
  return readFileSync(
    path.join(
      process.cwd(),
      "apps/gui/components/settings/editors/linear-settings-editor.tsx",
    ),
    "utf8",
  );
}

describe("linear settings immediate operations", () => {
  it("confirms and applies without a persistent Apply Changes card", () => {
    const source = readLinearEditor();
    expect(source).toContain("window.confirm");
    expect(source).toContain("commitAssociations");
    expect(source).toContain("applyLinearWorkspace");
    expect(source).toContain("LinearProvisionForm");
    expect(source).not.toContain("SettingsMutationPanel");
    expect(source).not.toContain("Credential:");
    expect(source).not.toContain("Configured teams:");
    expect(source).not.toContain("Configured projects:");
    expect(source).not.toContain("settings-linear-target-repo");
  });

  it("renders human-readable health labels instead of raw enums", () => {
    const source = readLinearEditor();
    expect(source).toContain("formatLinearEntityHealthLabel");
    expect(source).toContain("@harness/setup/linear-entity-health-label");
    expect(source).not.toContain("@harness/setup/linear-workspace-verify");
    expect(source).not.toContain(
      'teamEvidence?.health ?? "verification_pending"',
    );
    expect(source).not.toContain(
      'projectEvidence?.health ?? "verification_pending"',
    );
  });
});
