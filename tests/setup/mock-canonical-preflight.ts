import { vi } from "vitest";

vi.mock("../../src/workflow/canonical-workflow-gate.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/workflow/canonical-workflow-gate.js")>();
  return {
    ...actual,
    runAuthoritativeCanonicalWorkflowGate: vi.fn().mockResolvedValue({
      ok: true,
      resolvedStatuses: {},
      informationalWarnings: [],
    }),
  };
});
