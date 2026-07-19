import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRuntimeIntegrity } from "../../src/gui/runtime-integrity.js";

describe("runtime-integrity HTTP suite", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats root 307 as healthy when destination and assets succeed", async () => {
    const html = `
      <html><head>
        <link rel="stylesheet" href="/_next/static/css/app.css" />
        <script src="/_next/static/chunks/main.js"></script>
      </head>
      <body data-p-dev-runtime-smoke="1">ok</body></html>
    `;
    const css = ".x{color:red}".repeat(20);
    const js = "self.__next_f=[];".repeat(3);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/") && init?.redirect === "manual") {
          return new Response(null, {
            status: 307,
            headers: { location: "http://localhost:3999/workflow" },
          });
        }
        if (url.endsWith("/") && init?.redirect === "follow") {
          return new Response(html, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (url.includes("/_next/static/css/")) {
          return new Response(css, {
            status: 200,
            headers: { "content-type": "text/css" },
          });
        }
        if (url.includes("/_next/static/chunks/")) {
          return new Response(js, {
            status: 200,
            headers: { "content-type": "application/javascript" },
          });
        }
        if (url.includes("/api/setup/verify-saved-connections")) {
          return new Response(JSON.stringify({ health: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/setup/runtime-health")) {
          return new Response(
            JSON.stringify({
              snapshotId: "snap",
              sourceRoot: "/src",
              workspaceDir: "/ws",
              runtimeMode: "operator",
              buildId: "b1",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("missing", { status: 404 });
      }),
    );

    const result = await checkRuntimeIntegrity({
      baseUrl: "http://localhost:3999",
      expected: {
        snapshotId: "snap",
        sourceRoot: "/src",
        workspaceDir: "/ws",
        buildId: "b1",
        runtimeMode: "operator",
      },
    });
    expect(result.ok).toBe(true);
  });

  it("marks API module-loading 500 as unhealthy and recoverable", async () => {
    const html = `
      <html><head>
        <link rel="stylesheet" href="/_next/static/css/app.css" />
        <script src="/_next/static/chunks/main.js"></script>
      </head><body data-p-dev-runtime-smoke="1">ok</body></html>
    `;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/")) {
          return new Response(html, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (url.includes(".css")) {
          return new Response(".x{a:b}".repeat(20), {
            status: 200,
            headers: { "content-type": "text/css" },
          });
        }
        if (url.includes(".js") && url.includes("/_next/")) {
          return new Response("self.__next_f=self.__next_f||[];console.log(1);", {
            status: 200,
            headers: { "content-type": "application/javascript" },
          });
        }
        if (url.includes("verify-saved-connections")) {
          return new Response("<!DOCTYPE html>Cannot find module './8819.js'", {
            status: 500,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const result = await checkRuntimeIntegrity({
      baseUrl: "http://localhost:3999",
    });
    expect(result.ok).toBe(false);
    expect(result.category).toBe("api_module_error");
    expect(result.recoverableByRuntimeReset).toBe(true);
  });
});
