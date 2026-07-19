import { describe, expect, it, vi } from "vitest";
import { createMacOsBrowserOpener } from "../../src/p-dev/browser.js";

describe("p-dev browser opener compatibility export", () => {
  it("invokes macOS open with the target URL", async () => {
    const execFile = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const opener = createMacOsBrowserOpener(execFile as never);
    const previousPlatform = process.platform;

    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      await opener.open("http://localhost:3000/");
      expect(execFile).toHaveBeenCalledWith(
        "open",
        ["http://localhost:3000/"],
        { shell: false },
      );
    } finally {
      Object.defineProperty(process, "platform", { value: previousPlatform });
    }
  });

  it("uses linux xdg-open through the shared best-effort opener", async () => {
    const execFile = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const opener = createMacOsBrowserOpener(execFile as never);
    const previousPlatform = process.platform;

    Object.defineProperty(process, "platform", { value: "linux" });

    try {
      await opener.open("http://localhost:3000/");
      expect(execFile).toHaveBeenCalledWith(
        "xdg-open",
        ["http://localhost:3000/"],
        { shell: false },
      );
    } finally {
      Object.defineProperty(process, "platform", { value: previousPlatform });
    }
  });
});
