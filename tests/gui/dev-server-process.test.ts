import { describe, expect, it } from "vitest";
import { looksLikeGuiDevServer } from "../../src/gui/dev-server-process.js";

describe("dev-server-process", () => {
  it("detects Next.js GUI dev server commands", () => {
    expect(
      looksLikeGuiDevServer(
        "node /repo/node_modules/.bin/next dev --hostname localhost --port 3000",
      ),
    ).toBe(true);
    expect(
      looksLikeGuiDevServer(
        "next-server (v15.3.3) apps/gui",
      ),
    ).toBe(true);
  });

  it("does not treat unrelated processes as GUI dev servers", () => {
    expect(looksLikeGuiDevServer("postgres")).toBe(false);
    expect(looksLikeGuiDevServer("node /usr/local/bin/some-api.js")).toBe(false);
  });
});
