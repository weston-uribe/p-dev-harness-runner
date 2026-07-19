import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("Settings access for established repair", () => {
  it("allows established workspaces into Settings without initialSetup marker", async () => {
    const consoleLayout = await readFile(
      path.join(process.cwd(), "apps/gui/app/settings/(console)/layout.tsx"),
      "utf8",
    );
    expect(consoleLayout).toContain("classifyWorkspaceEntry");
    expect(consoleLayout).toContain('entry.maturity === "new"');
    expect(consoleLayout).not.toContain("isInitialSetupComplete(state)");
  });

  it("connections page accepts repair=vercel", async () => {
    const page = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/app/settings/(console)/connections/page.tsx",
      ),
      "utf8",
    );
    expect(page).toContain('params.repair === "vercel"');
    expect(page).toContain("repairVercel={repairVercel}");
  });
});
