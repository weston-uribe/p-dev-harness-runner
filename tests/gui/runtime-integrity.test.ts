import { describe, expect, it } from "vitest";
import {
  analyzeHydrationMarker,
  extractNextJsHrefs,
  validateJsAsset,
} from "../../src/gui/runtime-integrity.js";

describe("runtime-integrity", () => {
  it("extracts js asset hrefs from HTML", () => {
    const html = `
      <script src="/_next/static/chunks/webpack.js"></script>
      <script src="/_next/static/chunks/main.js"></script>
    `;
    expect(extractNextJsHrefs(html)).toEqual([
      "/_next/static/chunks/webpack.js",
      "/_next/static/chunks/main.js",
    ]);
  });

  it("rejects HTML returned for a JS asset as unhealthy", () => {
    const result = validateJsAsset({
      contentType: "text/html",
      body: "<!DOCTYPE html><html></html>",
      href: "/_next/static/chunks/main.js",
      status: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.category).toBe("invalid_js_asset");
    expect(result.recoverableByRuntimeReset).toBe(true);
  });

  it("rejects missing JS chunks (404) as unhealthy", () => {
    const result = validateJsAsset({
      contentType: "application/javascript",
      body: "",
      href: "/_next/static/chunks/missing.js",
      status: 404,
    });
    expect(result.ok).toBe(false);
    expect(result.recoverableByRuntimeReset).toBe(true);
  });

  it("accepts valid JS assets", () => {
    const result = validateJsAsset({
      contentType: "application/javascript",
      body: "self.__next_f=self.__next_f||[];",
      href: "/_next/static/chunks/main.js",
      status: 200,
    });
    expect(result.ok).toBe(true);
  });

  it("detects hydration smoke marker", () => {
    expect(
      analyzeHydrationMarker(
        '<body data-p-dev-runtime-smoke="1"></body>',
        'data-p-dev-runtime-smoke="1"',
      ).ok,
    ).toBe(true);
    expect(
      analyzeHydrationMarker("<body></body>", 'data-p-dev-runtime-smoke="1"')
        .ok,
    ).toBe(false);
  });
});
