import { describe, expect, it } from "vitest";
import { isPackagedPDevRuntime, resolvePDevRuntimeMode } from "../../src/p-dev/runtime-mode.js";

describe("p-dev runtime mode", () => {
  it("detects packaged runtime mode", () => {
    expect(resolvePDevRuntimeMode({ P_DEV_RUNTIME_MODE: "packaged" })).toBe(
      "packaged",
    );
    expect(isPackagedPDevRuntime({ P_DEV_RUNTIME_MODE: "packaged" })).toBe(true);
  });

  it("detects source runtime mode", () => {
    expect(resolvePDevRuntimeMode({ P_DEV_RUNTIME_MODE: "source" })).toBe(
      "source",
    );
    expect(isPackagedPDevRuntime({ P_DEV_RUNTIME_MODE: "source" })).toBe(false);
  });
});
