import { describe, expect, it } from "vitest";
import { parsePDevCliOptions } from "../../src/p-dev/cli.js";

describe("p-dev cli", () => {
  it("defaults to root route and browser open", () => {
    expect(parsePDevCliOptions([])).toEqual({
      route: "/",
      openBrowser: true,
    });
  });

  it("parses host, port, workspace, route, and no-open", () => {
    expect(
      parsePDevCliOptions([
        "--host",
        "127.0.0.1",
        "--port",
        "3333",
        "--workspace",
        "/tmp/p-dev-workspace",
        "--route",
        "/settings/configure",
        "--no-open",
      ]),
    ).toEqual({
      host: "127.0.0.1",
      port: 3333,
      workspace: "/tmp/p-dev-workspace",
      route: "/settings/configure",
      openBrowser: false,
    });
  });

  it("rejects invalid ports", () => {
    expect(() => parsePDevCliOptions(["--port", "0"])).toThrow(
      "valid TCP port",
    );
  });
});
