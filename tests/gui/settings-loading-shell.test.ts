import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("settings navigation performance surfaces", () => {
  it("provides a Settings console loading shell and Workflow prefetch", () => {
    const loadingPath = path.join(
      process.cwd(),
      "apps/gui/app/settings/(console)/loading.tsx",
    );
    expect(existsSync(loadingPath)).toBe(true);
    const loading = readFileSync(loadingPath, "utf8");
    expect(loading).toContain("SettingsShell");
    expect(loading).toContain("Loading settings");

    const workflowClient = readFileSync(
      path.join(
        process.cwd(),
        "apps/gui/components/workflow/workflow-page-client.tsx",
      ),
      "utf8",
    );
    expect(workflowClient).toContain("SETTINGS_DEFAULT_ROUTE");
    expect(workflowClient).toContain("router.prefetch");

    // Timing note for stop report (dev): shell paints via loading.tsx before
    // Connections verify-saved-connections; layout still awaits classify +
    // setup summaries, but no longer blocks the segment behind a blank page.
  });
});
