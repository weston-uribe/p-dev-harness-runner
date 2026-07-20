import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("settings mutation editors", () => {
  it("documents the settings mutation flow", async () => {
    const mutationDoc = await readFile(
      path.join(process.cwd(), "apps/gui/lib/settings/settings-mutation.ts"),
      "utf8",
    );
    expect(mutationDoc).toContain("Load committed state");
    expect(mutationDoc).toContain("explicit confirmation");
  });

  it("uses dedicated settings editors instead of wizard cards", async () => {
    const connectionsPage = await readFile(
      path.join(process.cwd(), "apps/gui/app/settings/(console)/connections/page.tsx"),
      "utf8",
    );
    const linearPage = await readFile(
      path.join(process.cwd(), "apps/gui/app/settings/(console)/linear/page.tsx"),
      "utf8",
    );

    expect(connectionsPage).toContain("ConnectionsSettingsEditor");
    expect(connectionsPage).not.toContain("GuidedLinearWorkspaceCard");
    expect(linearPage).toContain("LinearSettingsEditor");
    expect(linearPage).not.toContain("guided-linear-workspace-card");
  });

  it("rolls back credential UI by clearing draft values after successful save", async () => {
    const connectionsEditor = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/settings/editors/connections-settings-editor.tsx",
      ),
      "utf8",
    );
    expect(connectionsEditor).toContain("/api/setup/patch-credential");
    expect(connectionsEditor).toContain("[SERVICE_VALUE_KEY[key]]: \"\"");
    expect(connectionsEditor).toContain(
      "The previous value was preserved.",
    );
  });

  it("detaches repositories in config only", async () => {
    const repositoriesEditor = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/settings/editors/repositories-settings-editor.tsx",
      ),
      "utf8",
    );
    expect(repositoriesEditor).toContain("Remove from PDev");
    expect(repositoriesEditor).toContain("will not be deleted");
    expect(repositoriesEditor).toContain('kind: "repos"');
    expect(repositoriesEditor).not.toContain("Delete repository");
  });

  it("scopes Linear workspace editor to collection setup APIs", async () => {
    const linearEditor = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/settings/editors/linear-settings-editor.tsx",
      ),
      "utf8",
    );
    const mutationPanel = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/settings/settings-mutation-panel.tsx",
      ),
      "utf8",
    );
    const confirmation = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/custom/remote-action-confirmation.tsx",
      ),
      "utf8",
    );
    expect(linearEditor).toContain("previewLinearWorkspace");
    expect(linearEditor).toContain("applyLinearWorkspace");
    expect(linearEditor).toContain("window.confirm");
    expect(linearEditor).toContain("/api/setup/linear-options");
    expect(linearEditor).toContain("Remove from PDev");
    expect(linearEditor).not.toContain("SettingsMutationPanel");
    expect(linearEditor).not.toContain("previewLinearSetup");
    expect(mutationPanel).toContain('previewPolicy = "required"');
    expect(mutationPanel).toContain("Optional");
    expect(mutationPanel).toContain("Review the planned changes before applying.");
    expect(confirmation).toContain(
      "I understand PDev will create or repair the required workflow statuses",
    );
    expect(confirmation).not.toContain(
      "I reviewed the Linear setup preview and want to apply workspace changes.",
    );
  });

  it("standardizes optional preview Apply cards for Linear and Deployments", async () => {
    const mutationPanel = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/settings/settings-mutation-panel.tsx",
      ),
      "utf8",
    );
    const deploymentsEditor = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/settings/editors/deployments-settings-editor.tsx",
      ),
      "utf8",
    );
    const connectionsEditor = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/settings/editors/connections-settings-editor.tsx",
      ),
      "utf8",
    );
    const confirmation = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/custom/remote-action-confirmation.tsx",
      ),
      "utf8",
    );

    expect(mutationPanel).toMatch(
      /Optional[\s\S]*\{phase === "previewing" \? "Previewing…" : previewLabel\}/,
    );
    expect(mutationPanel).toMatch(
      /RemoteActionConfirmation[\s\S]*\{phase === "applying" \? "Applying…" : applyLabel\}/,
    );
    expect(mutationPanel.indexOf("RemoteActionConfirmation")).toBeLessThan(
      mutationPanel.lastIndexOf("onApply"),
    );

    expect(deploymentsEditor).toContain("previewVercelBridge(buildPlanPayload())");
    expect(deploymentsEditor).toContain("Save deployment selection");
    expect(deploymentsEditor).toContain("window.confirm");
    expect(deploymentsEditor).not.toContain("SettingsMutationPanel");
    expect(deploymentsEditor).not.toContain("Apply deployment changes");

    expect(connectionsEditor).not.toContain('previewPolicy="optional"');
    expect(mutationPanel).toContain('previewPolicy = "required"');

    expect(confirmation).toContain(
      "I understand PDev will save the selected Vercel team and project",
    );
    expect(confirmation).not.toContain(
      "I reviewed the Vercel settings preview and want to apply these changes.",
    );
  });
});
