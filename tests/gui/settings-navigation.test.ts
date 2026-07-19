import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("settings navigation and routing", () => {
  it("redirects /settings to the default settings section", async () => {
    const settingsIndexPage = await readFile(
      path.join(process.cwd(), "apps/gui/app/settings/(console)/page.tsx"),
      "utf8",
    );
    const consoleLayout = await readFile(
      path.join(process.cwd(), "apps/gui/app/settings/(console)/layout.tsx"),
      "utf8",
    );
    const settingsNavigation = await readFile(
      path.join(process.cwd(), "apps/gui/lib/settings/settings-navigation.ts"),
      "utf8",
    );

    expect(settingsIndexPage).toContain("SETTINGS_DEFAULT_ROUTE");
    expect(settingsNavigation).toContain('href: "/settings/connections"');
    expect(settingsNavigation).not.toContain("Overview");
    expect(settingsNavigation).not.toContain("Automation");
    expect(settingsNavigation).not.toContain("Diagnostics");
    expect(settingsNavigation).not.toContain("Advanced");
    expect(consoleLayout).toContain("SettingsShell");
    expect(consoleLayout).toContain("classifyWorkspaceEntry");
    expect(consoleLayout).toContain('entry.maturity === "new"');
    expect(consoleLayout).toContain("redirect(CONFIGURE_ROUTE)");
  });

  it("redirects completed configure sessions to /settings", async () => {
    const configurePage = await readFile(
      path.join(process.cwd(), "apps/gui/app/settings/configure/page.tsx"),
      "utf8",
    );

    expect(configurePage).toContain("migrateExistingCompletedWorkspace");
    expect(configurePage).toContain("redirect(WORKFLOW_ROUTE)");
  });

  it("moves data-sharing into the console route group", async () => {
    const dataSharingPage = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/app/settings/(console)/data-sharing/page.tsx",
      ),
      "utf8",
    );

    expect(dataSharingPage).toContain("DataSharingPreferences");
    expect(dataSharingPage).not.toContain("AppShell");
  });

  it("uses /settings as the primary settings menu destination", async () => {
    const settingsMenu = await readFile(
      path.join(process.cwd(), "apps/gui/components/custom/settings-menu.tsx"),
      "utf8",
    );
    const workflowPage = await readFile(
      path.join(process.cwd(), "apps/gui/app/workflow/page.tsx"),
      "utf8",
    );
    const consoleLayout = await readFile(
      path.join(process.cwd(), "apps/gui/app/settings/(console)/layout.tsx"),
      "utf8",
    );

    expect(settingsMenu).toContain('settingsHref = "/settings"');
    expect(settingsMenu).toContain("Settings");
    expect(settingsMenu).toContain("Workflow");
    expect(settingsMenu).toContain("showProductNavigation = true");
    expect(settingsMenu).not.toContain("Setup wizard");
    expect(settingsMenu).not.toContain("Data sharing");
    expect(workflowPage).toContain("<AppShell");
    expect(workflowPage).not.toContain("showProductNavigation={false}");
    expect(consoleLayout).toContain("<AppShell");
    expect(consoleLayout).not.toContain("showProductNavigation={false}");
  });

  it("shares workflow model save hook for settings models page", async () => {
    const modelsClient = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/components/settings/settings-models-client.tsx",
      ),
      "utf8",
    );
    const workflowAutosave = await readFile(
      path.join(process.cwd(), "apps/gui/lib/workflow/use-model-autosave.ts"),
      "utf8",
    );

    expect(modelsClient).toContain("useModelAutosave");
    expect(workflowAutosave).toContain("useWorkflowModelSave");
  });
});
