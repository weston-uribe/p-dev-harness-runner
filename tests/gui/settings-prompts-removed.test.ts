import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("settings prompts route removed", () => {
  it("drops nav entry and page-only surfaces while keeping src/prompts", () => {
    const nav = readFileSync(
      path.join(process.cwd(), "apps/gui/lib/settings/settings-navigation.ts"),
      "utf8",
    );
    expect(nav).not.toContain("/settings/prompts");
    expect(nav).not.toContain("Prompts and skills");
    expect(
      existsSync(
        path.join(
          process.cwd(),
          "apps/gui/app/settings/(console)/prompts/page.tsx",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          process.cwd(),
          "apps/gui/components/settings/settings-prompts-client.tsx",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          process.cwd(),
          "apps/gui/app/api/settings/prompt-config/route.ts",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(path.join(process.cwd(), "src/prompts/contracts.ts")),
    ).toBe(true);
  });
});
