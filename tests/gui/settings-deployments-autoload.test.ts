import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("settings deployments summary-only contract", () => {
  it("renders a read-only Team, Project, and Production URL summary", async () => {
    const editor = await read(
      "apps/gui/components/settings/editors/deployments-settings-editor.tsx",
    );
    const page = await read(
      "apps/gui/app/settings/(console)/deployments/page.tsx",
    );

    expect(editor).toContain("Team:");
    expect(editor).toContain("Project:");
    expect(editor).toContain("Production URL:");
    expect(editor).toContain("Not configured");
    expect(editor).toContain("Settings → Connections");
    expect(editor).toContain('href="/settings/connections"');

    expect(editor).not.toContain("Scope:");
    expect(editor).not.toContain("Current project:");
    expect(editor).not.toContain("Bridge:");
    expect(editor).not.toContain("Linear webhook:");
    expect(editor).not.toContain("Last verified:");
    expect(editor).not.toContain("Save deployment selection");
    expect(editor).not.toContain("GuidedSelect");
    expect(editor).not.toContain('fetch("/api/setup/vercel-bridge-options")');
    expect(editor).not.toContain("Loading Vercel teams…");
    expect(editor).not.toContain("Loading Vercel projects…");
    expect(editor).not.toContain("applyVercelBridge");
    expect(editor).not.toContain("previewVercelBridge");
    expect(editor).not.toContain("SettingsMutationPanel");

    expect(page).toContain("Review the active Vercel");
    expect(page).not.toContain("Configure Vercel deployment bridge settings.");
  });
});
