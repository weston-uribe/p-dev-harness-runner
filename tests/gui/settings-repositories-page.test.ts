import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("settings repositories page", () => {
  it("renders a compact repository management surface", async () => {
    const page = await read("apps/gui/app/settings/(console)/repositories/page.tsx");
    const editor = await read(
      "apps/gui/components/settings/editors/repositories-settings-editor.tsx",
    );

    expect(page).toContain("Target repositories");
    expect(page).toContain("RepositoriesSettingsEditor");
    expect(page).not.toContain("TargetRepositoriesOverview");
    expect(page).not.toContain("Repository status");

    expect(editor).toContain("Add repository");
    expect(editor).toContain("Verify or repair");
    expect(editor).toContain("Edit branches");
    expect(editor).toContain("Remove from PDev");
    expect(editor).toContain("TargetRepoCreateConnect");
    expect(editor).toContain("Development branch");
    expect(editor).toContain("Production branch");
    expect(editor).toContain("verifyBranches: true");
    expect(editor).toContain("requireDistinctBranches: true");
    expect(editor).toContain("/api/setup/verify-target-repo");
    expect(editor).not.toContain("Delete repository");
    expect(editor).not.toContain("api.github.com");
    expect(editor).not.toContain("linear-team-key");
    expect(editor).not.toContain("Model ID");
    expect(editor).not.toContain("preview-provider");
    expect(editor).not.toContain("integration-preview-url");
    expect(editor).not.toContain("production-url");
    expect(editor).not.toContain("integration-success-status");
    expect(editor).not.toContain("production-success-status");
    expect(editor).not.toContain("validation-commands");
    expect(editor).not.toContain("TargetRepoConfigForm");
    expect(editor).toContain("Settings → Linear");
    expect(editor).toContain("Cannot remove");
  });

  it("uses merge-preserving repos patches that keep hidden fields", async () => {
    const patchSource = await read("src/setup/settings-config-patch.ts");
    expect(patchSource).toContain("linearAssociations");
    expect(patchSource).toContain("mergeReposFromFormInput");
    expect(patchSource).toContain("listRepoDetachDependencies");
    expect(patchSource).toContain("settings_config_detach_blocked");
    expect(patchSource).toContain("assertRepoBranchesExistRemote");
  });
});
