import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("settings deployments Vercel options auto-load", () => {
  it("loads Vercel options automatically without a Load button", async () => {
    const editor = await read(
      "apps/gui/components/settings/editors/deployments-settings-editor.tsx",
    );

    expect(editor).not.toContain("Load Vercel options");
    expect(editor).not.toContain("Load Vercel Options");
    expect(editor).toContain("vercelTokenConfigured");
    expect(editor).toContain('fetch("/api/setup/vercel-bridge-options")');
    expect(editor).toContain("projectsOnly=true");
    expect(editor).toContain("Loading Vercel teams…");
    expect(editor).toContain("Loading Vercel projects…");
    expect(editor).toContain("Settings → Connections");
    expect(editor).toContain('href="/settings/connections"');
    expect(editor).toContain("Retry");
    expect(editor).toContain("teamsRequestIdRef");
    expect(editor).toContain("projectsRequestIdRef");
    expect(editor).toContain("mountedRef");
    expect(editor).toContain("loadedCredentialRef");
    expect(editor).toContain("Save deployment selection");
    expect(editor).toContain("window.confirm");
    expect(editor).toContain("applyVercelBridge({");
    expect(editor).toContain("previewVercelBridge(buildPlanPayload())");
    expect(editor).toContain("committedTeamId");
    expect(editor).not.toContain("SettingsMutationPanel");
    expect(editor).not.toMatch(/VERCEL_TOKEN\s*[:=]\s*["'][^"']+["']/);
    expect(editor).not.toContain("sk_");
  });

  it("does not request options when no Vercel credential is configured", async () => {
    const editor = await read(
      "apps/gui/components/settings/editors/deployments-settings-editor.tsx",
    );
    expect(editor).toContain("if (!summary.vercelTokenConfigured)");
    expect(editor).toContain("Connect Vercel in");
    expect(editor).toMatch(
      /if \(!summary\.vercelTokenConfigured\) \{\s*return;/,
    );
  });

  it("preserves committed selections through loading and ignores stale responses", async () => {
    const editor = await read(
      "apps/gui/components/settings/editors/deployments-settings-editor.tsx",
    );
    expect(editor).toContain("committedProjectId");
    expect(editor).toContain("requestId !== teamsRequestIdRef.current");
    expect(editor).toContain("requestId !== projectsRequestIdRef.current");
    expect(editor).toContain("Clear only an unsaved selection");
  });
});
