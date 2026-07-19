import { describe, expect, it } from "vitest";
import { checkNodeVersion, parseNodeMajor } from "../../src/p-dev/node-version.js";

describe("p-dev node version", () => {
  it("parses major versions from node version strings", () => {
    expect(parseNodeMajor("v22.13.10")).toBe(22);
    expect(parseNodeMajor("21.7.3")).toBe(21);
  });

  it("accepts supported Node versions", () => {
    expect(checkNodeVersion("v22.0.0")).toEqual({ ok: true });
  });

  it("rejects unsupported Node versions with a clear message", () => {
    const result = checkNodeVersion("v20.19.0");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("requires Node.js 22+");
    expect(result.message).toContain("v20.19.0");
  });
});
