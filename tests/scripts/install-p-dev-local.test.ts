import { describe, expect, it } from "vitest";
import {
  classifyExistingPDev,
  resolveCommandPath,
} from "../../scripts/install-p-dev-local.ts";

describe("install-p-dev-local", () => {
  it("classifies missing commands", async () => {
    expect(await classifyExistingPDev(undefined)).toBe("missing");
  });

  it("classifies known pdev executables for replacement", async () => {
    expect(
      await classifyExistingPDev("/usr/local/lib/node_modules/p-dev-harness/bin/p-dev.js"),
    ).toBe("known-pdev");
  });

  it("classifies unrelated executables as foreign", async () => {
    expect(await classifyExistingPDev("/usr/bin/p-dev")).toBe("foreign");
  });

  it("resolves command path helper without throwing when missing", async () => {
    const resolved = await resolveCommandPath("definitely-not-a-real-command-xyz");
    expect(resolved).toBeUndefined();
  });
});
