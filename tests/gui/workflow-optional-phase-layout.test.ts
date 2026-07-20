import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow optional phase layout", () => {
  it("uses solid borders and spacing for review cards", () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        "apps/gui/components/workflow/workflow-cards-section.tsx",
      ),
      "utf8",
    );
    expect(source).toContain('data-testid="optional-phase-card"');
    expect(source).toContain("mt-3 rounded-md border border-border");
    expect(source).not.toContain("border-dashed");
    expect(source).toContain('className="space-y-3"');
  });
});
