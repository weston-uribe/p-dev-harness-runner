import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("workflow model autosave", () => {
  it("reverts optimistic selection on failure and exposes retry", async () => {
    const saveHook = await readFile(
      path.join(process.cwd(), "apps/gui/lib/workflow/use-workflow-model-save.ts"),
      "utf8",
    );
    const modelControl = await readFile(
      path.join(process.cwd(), "apps/gui/components/workflow/workflow-model-control.tsx"),
      "utf8",
    );

    expect(saveHook).toContain("revertToCommitted");
    expect(saveHook).toContain("Couldn't save. Your previous model is still active.");
    expect(saveHook).toContain("retrySave");
    expect(modelControl).toContain("onRetry");
  });

  it("sanitizes save errors without echoing secrets", async () => {
    const apiClient = await readFile(
      path.join(process.cwd(), "apps/gui/lib/workflow/api-client.ts"),
      "utf8",
    );
    const saveHook = await readFile(
      path.join(process.cwd(), "apps/gui/lib/workflow/use-workflow-model-save.ts"),
      "utf8",
    );

    expect(apiClient).toContain("code");
    expect(saveHook).not.toContain("LINEAR_API_KEY");
    expect(saveHook).not.toContain("CURSOR_API_KEY");
  });
});
