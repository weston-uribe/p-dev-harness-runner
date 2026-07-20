import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("AutomationHealthFacts attention-only contract", () => {
  it("derives panel state from both aggregates and returns null when healthy", () => {
    const component = read(
      "apps/gui/components/settings/automation-health-facts.tsx",
    );
    expect(component).toContain("deriveAutomationAttentionState");
    expect(component).toContain("if (!attention)");
    expect(component).toContain("return null");
    expect(component).not.toContain("showVerifiedMark");
    expect(component).not.toContain("Automation: Verified");
    expect(component).not.toContain(" ✓");
    expect(component).not.toContain("border-emerald");
    expect(component).not.toContain("vercel.automationAggregate === \"verified\"");
  });

  it("is shared by Workflow and Connections without a success banner path", () => {
    const workflow = read("apps/gui/app/workflow/page.tsx");
    const connections = read(
      "apps/gui/app/settings/(console)/connections/page.tsx",
    );
    expect(workflow).toContain("AutomationHealthFacts");
    expect(connections).toContain("AutomationHealthFacts");
    expect(workflow).not.toContain("showAutomationStrip");
  });
});
