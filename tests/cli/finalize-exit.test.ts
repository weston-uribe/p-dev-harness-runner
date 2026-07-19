import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeCliExit } from "../../src/cli/finalize-exit.js";

describe("finalizeCliExit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits with the provided exit code", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    expect(() => finalizeCliExit(2)).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("defaults to exit code 0 when exit code is not a finite number", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    for (const code of [undefined, null, "2"] as const) {
      expect(() => finalizeCliExit(code)).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenLastCalledWith(0);
    }
  });
});
