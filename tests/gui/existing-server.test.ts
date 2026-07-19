import { describe, expect, it } from "vitest";
import { registryMatchesWorkspace } from "../../src/gui/existing-server.js";
import { createRegistryRecord } from "../../src/gui/runtime-registry.js";

describe("existing-server reuse", () => {
  it("matches same workspace and rejects different workspace", () => {
    const record = createRegistryRecord({
      sourceRoot: "/src",
      workspaceDir: "/workspace-a",
      host: "localhost",
      port: 3001,
      pid: 1,
    });

    expect(
      registryMatchesWorkspace(record, {
        sourceRoot: "/src",
        workspaceDir: "/workspace-a",
      }),
    ).toBe(true);
    expect(
      registryMatchesWorkspace(record, {
        sourceRoot: "/src",
        workspaceDir: "/workspace-b",
      }),
    ).toBe(false);
  });
});
