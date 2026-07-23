import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("cursor usage settings navigation", () => {
  it("includes Cursor usage in settings navigation", async () => {
    const settingsNavigation = await readFile(
      path.join(process.cwd(), "apps/gui/lib/settings/settings-navigation.ts"),
      "utf8",
    );

    expect(settingsNavigation).toContain('href: "/settings/cursor-usage"');
    expect(settingsNavigation).toContain('label: "Cursor usage"');
  });

  it("registers the cursor usage settings page route", async () => {
    const page = await readFile(
      path.join(
        process.cwd(),
        "apps/gui/app/settings/(console)/cursor-usage/page.tsx",
      ),
      "utf8",
    );

    expect(page).toContain("CursorUsagePage");
    expect(page).not.toContain("LANGFUSE_SECRET_KEY");
    expect(page).not.toContain("LANGFUSE_PUBLIC_KEY");
  });
});
