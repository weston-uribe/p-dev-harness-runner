import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("settings and workflow pointer cursors", () => {
  it("uses pointer cursor on settings dropdown items and trigger", () => {
    const dropdownSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/ui/dropdown-menu.tsx"),
      "utf8",
    );
    const settingsSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/settings-menu.tsx"),
      "utf8",
    );

    expect(dropdownSource).toContain("cursor-pointer");
    expect(dropdownSource).toContain("data-[disabled]:cursor-not-allowed");
    expect(settingsSource).toContain('className="cursor-pointer gap-1.5"');
  });

  it("uses pointer cursor on workflow card expand buttons", () => {
    const source = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/workflow/workflow-cards-section.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("cursor-pointer");
    expect(source).toContain("aria-expanded={isExpanded}");
  });
});
