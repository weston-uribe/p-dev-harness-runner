import { describe, expect, it } from "vitest";
import {
  analyzeConfigurePageHtml,
  extractNextCssHref,
  validateConfigureCssAsset,
} from "../../src/gui/configure-health.js";

describe("configure-health", () => {
  it("accepts HTML with a Next.js CSS bundle link", () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="/_next/static/css/app/layout.css?v=1" />
        </head>
        <body>Configure</body>
      </html>
    `;

    expect(analyzeConfigurePageHtml(html)).toEqual({
      ok: true,
      recoverableByCacheReset: false,
    });
    expect(extractNextCssHref(html)).toBe(
      "/_next/static/css/app/layout.css?v=1",
    );
  });

  it("rejects HTML without Next static assets", () => {
    const result = analyzeConfigurePageHtml("<html><body>Configure</body></html>");
    expect(result.ok).toBe(false);
    expect(result.category).toBe("missing_static_assets");
    expect(result.recoverableByCacheReset).toBe(true);
  });

  it("rejects HTML missing CSS bundle links", () => {
    const result = analyzeConfigurePageHtml(
      '<html><script src="/_next/static/chunks/main.js"></script></html>',
    );
    expect(result.ok).toBe(false);
    expect(result.category).toBe("missing_css_bundle");
    expect(result.recoverableByCacheReset).toBe(true);
  });

  it("validates CSS asset content type and size", () => {
    const css = ".bg-background { background: oklch(1 0 0); }".repeat(5);
    expect(
      validateConfigureCssAsset({
        contentType: "text/css; charset=UTF-8",
        body: css,
        href: "/_next/static/css/app/layout.css",
      }),
    ).toEqual({ ok: true, recoverableByCacheReset: false });
  });

  it("marks invalid css assets as recoverable", () => {
    const result = validateConfigureCssAsset({
      contentType: "text/html",
      body: "<html></html>",
      href: "/_next/static/css/app/layout.css",
    });
    expect(result.ok).toBe(false);
    expect(result.recoverableByCacheReset).toBe(true);
  });

  it("rejects tiny css assets", () => {
    expect(
      validateConfigureCssAsset({
        contentType: "text/css",
        body: ".x{}",
        href: "/_next/static/css/app/layout.css",
      }).ok,
    ).toBe(false);
  });
});
