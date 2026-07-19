import { describe, expect, it, vi } from "vitest";
import {
  createBestEffortBrowserOpener,
  openBrowserBestEffort,
  resolveBrowserCommand,
} from "../../src/gui/browser-opener.js";

describe("browser opener", () => {
  it("selects platform-specific commands", () => {
    const previousPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      expect(resolveBrowserCommand("http://localhost:3000/")).toEqual({
        command: "open",
        args: ["http://localhost:3000/"],
      });

      Object.defineProperty(process, "platform", { value: "linux" });
      expect(resolveBrowserCommand("http://localhost:3000/").command).toBe(
        "xdg-open",
      );

      Object.defineProperty(process, "platform", { value: "win32" });
      expect(resolveBrowserCommand("http://localhost:3000/").command).toBe(
        "cmd",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: previousPlatform });
    }
  });

  it("returns a warning instead of throwing when browser launch fails", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("launch failed");
    });
    const result = await openBrowserBestEffort(
      "http://localhost:3000/",
      execFile as never,
    );
    expect(result.opened).toBe(false);
    expect(result.warning).toContain("http://localhost:3000/");
  });

  it("does not throw from best-effort opener wrapper", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("launch failed");
    });
    const opener = createBestEffortBrowserOpener(execFile as never);
    await expect(opener.open("http://localhost:3000/")).resolves.toBeUndefined();
  });
});
