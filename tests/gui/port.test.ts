import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUI_HOST,
  DEFAULT_GUI_PORT,
  resolveAvailableGuiPort,
  resolveGuiHost,
  resolveRequestedGuiPort,
} from "../../src/gui/port.js";

describe("gui port resolution", () => {
  it("defaults to localhost:3000", () => {
    expect(resolveGuiHost({})).toBe(DEFAULT_GUI_HOST);
    expect(resolveRequestedGuiPort({})).toBe(DEFAULT_GUI_PORT);
  });

  it("prefers CLI port over env port", () => {
    expect(
      resolveRequestedGuiPort({
        port: 4000,
        envPort: "5000",
      }),
    ).toBe(4000);
  });

  it("reads HARNESS_GUI_PORT from env when CLI port is absent", () => {
    const previous = process.env.HARNESS_GUI_PORT;
    process.env.HARNESS_GUI_PORT = "3333";

    try {
      expect(resolveRequestedGuiPort({})).toBe(3333);
    } finally {
      if (previous === undefined) {
        delete process.env.HARNESS_GUI_PORT;
      } else {
        process.env.HARNESS_GUI_PORT = previous;
      }
    }
  });

  it("finds the next available port when the default is busy", async () => {
    const net = await import("node:net");
    const blocker = net.createServer();
    const blockedPort = await new Promise<number>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, DEFAULT_GUI_HOST, () => {
        const address = blocker.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not resolve ephemeral blocker port"));
          return;
        }
        resolve(address.port);
      });
    });

    try {
      const resolution = await resolveAvailableGuiPort({
        host: DEFAULT_GUI_HOST,
        port: blockedPort,
      });
      expect(resolution.port).toBe(blockedPort + 1);
      expect(resolution.requestedPort).toBe(blockedPort);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
