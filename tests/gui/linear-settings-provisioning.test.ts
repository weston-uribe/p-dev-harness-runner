import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("linear settings provisioning", () => {
  it("supports the three required create/associate combinations through shared helpers", () => {
    const helpers = read("apps/gui/lib/linear-provisioning.ts");
    const form = read("apps/gui/components/settings/linear-provision-form.tsx");
    const editor = read(
      "apps/gui/components/settings/editors/linear-settings-editor.tsx",
    );

    expect(helpers).toContain("supportsRequestedProvisionMode");
    expect(helpers).toContain(
      'input.teamMode === "existing" && input.projectMode === "existing"',
    );
    expect(helpers).toContain(
      'input.teamMode === "existing" && input.projectMode === "create"',
    );
    expect(helpers).toContain(
      'input.teamMode === "create" && input.projectMode === "create"',
    );

    expect(form).toContain("previewLinearSetup");
    expect(form).toContain("applyLinearSetup");
    expect(form).toContain("previewLinearWorkspace");
    expect(form).toContain("applyLinearWorkspace");
    expect(form).toContain("submitGenerationRef");
    expect(form).toContain("Create new team");
    expect(form).toContain("Create new project");
    expect(form).toContain("Use existing team");
    expect(form).toContain("Use existing project");

    expect(editor).toContain("LinearProvisionForm");
    expect(editor).toContain("syncLinearAssociationCloudConfig");
    expect(editor).not.toContain("Add selected projects");
    expect(form).toContain("Retry cloud config sync");
  });

  it("guards against duplicate client submissions while busy", () => {
    const form = read("apps/gui/components/settings/linear-provision-form.tsx");
    expect(form).toContain("submitGenerationRef");
    expect(form).toContain("if (generation !== submitGenerationRef.current)");
    expect(form).toContain("setBusy(true)");
    expect(form).toMatch(/busy \|\| disabled/);
  });

  it("reuses guided provisioning helpers instead of duplicating plan builders", () => {
    const guided = read(
      "apps/gui/components/custom/guided-linear-workspace-card.tsx",
    );
    expect(guided).toContain('from "@/lib/linear-provisioning"');
    expect(guided).toContain("buildSharedSetupPlanPayload");
    expect(guided).toContain("buildSharedWorkspacePlanPayload");
    expect(guided).not.toContain("type PendingLinearCreateEntry = {");
  });
});
