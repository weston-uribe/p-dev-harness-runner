import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("settings navigation performance surfaces", () => {
  it("keeps Settings console loading inside the existing shell", () => {
    const loadingPath = path.join(
      process.cwd(),
      "apps/gui/app/settings/(console)/loading.tsx",
    );
    expect(existsSync(loadingPath)).toBe(true);
    const loading = readFileSync(loadingPath, "utf8");
    expect(loading).toContain("Loading settings");
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toMatch(/from ["']@\/components\/custom\/app-shell["']/);
    expect(loading).not.toMatch(
      /from ["']@\/components\/settings\/settings-shell["']/,
    );

    const layout = readFileSync(
      path.join(
        process.cwd(),
        "apps/gui/app/settings/(console)/layout.tsx",
      ),
      "utf8",
    );
    expect(layout).toContain("AppShell");
    expect(layout).toContain("SettingsShell");

    const workflowClient = readFileSync(
      path.join(
        process.cwd(),
        "apps/gui/components/workflow/workflow-page-client.tsx",
      ),
      "utf8",
    );
    expect(workflowClient).toContain("SETTINGS_DEFAULT_ROUTE");
    expect(workflowClient).toContain("router.prefetch");
  });
});
