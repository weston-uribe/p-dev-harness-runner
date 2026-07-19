import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow source UI", () => {
  it("does not reference canvas, draft, or react-flow artifacts", () => {
    const clientSource = readFileSync(
      path.join(process.cwd(), "apps/gui/components/workflow/workflow-page-client.tsx"),
      "utf8",
    );
    expect(clientSource).not.toContain("react-flow");
    expect(clientSource).not.toContain("draft");
    expect(clientSource).toContain("fetchWorkflowBootstrap");
  });

  it("package manifest does not depend on @xyflow/react", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.["@xyflow/react"]).toBeUndefined();
  });
});
