export type GuiHealthCategory =
  | "unreachable"
  | "http_error"
  | "missing_static_assets"
  | "missing_css_bundle"
  | "invalid_css_asset"
  | "unexpected_page_error";

export interface GuiHealthResult {
  ok: boolean;
  category?: GuiHealthCategory;
  reason?: string;
  recoverableByCacheReset: boolean;
}

/** @deprecated Use GuiHealthResult */
export interface ConfigureHealthResult {
  ok: boolean;
  reason?: string;
}

export const CANONICAL_CONFIGURE_URL =
  "http://localhost:3000/settings/configure";

function success(): GuiHealthResult {
  return { ok: true, recoverableByCacheReset: false };
}

function failure(
  category: GuiHealthCategory,
  reason: string,
  recoverableByCacheReset = false,
): GuiHealthResult {
  return {
    ok: false,
    category,
    reason,
    recoverableByCacheReset,
  };
}

export function analyzeConfigurePageHtml(html: string): GuiHealthResult {
  if (!html.includes("/_next/static/")) {
    return failure(
      "missing_static_assets",
      "Page HTML is missing Next.js static asset references. The dev server may be serving a broken build or corrupt .next cache.",
      true,
    );
  }

  const cssHref = extractNextCssHref(html);
  if (!cssHref) {
    return failure(
      "missing_css_bundle",
      "Page HTML is missing a Next.js CSS bundle link. The UI will likely render unstyled.",
      true,
    );
  }

  return success();
}

export function validateConfigureCssAsset(input: {
  contentType: string | null;
  body: string;
  href: string;
}): GuiHealthResult {
  const contentType = input.contentType ?? "";
  if (!contentType.includes("text/css")) {
    return failure(
      "invalid_css_asset",
      `CSS asset ${input.href} returned unexpected content-type: ${contentType || "(missing)"}`,
      true,
    );
  }

  if (input.body.trim().length < 100) {
    return failure(
      "invalid_css_asset",
      `CSS asset ${input.href} is suspiciously small (${input.body.length} bytes).`,
      true,
    );
  }

  return success();
}

export function extractNextCssHref(html: string): string | undefined {
  const patterns = [
    /href="(\/_next\/static\/css\/[^"]+\.css[^"]*)"/,
    /href='(\/_next\/static\/css\/[^']+\.css[^']*)'/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

export async function checkGuiPageHealth(
  pageUrl: string,
): Promise<GuiHealthResult> {
  let response: Response;
  try {
    response = await fetch(pageUrl, { redirect: "follow" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      "unreachable",
      `Could not reach ${pageUrl}: ${message}`,
      false,
    );
  }

  if (!response.ok) {
    return failure(
      "http_error",
      `${pageUrl} returned HTTP ${response.status}`,
      false,
    );
  }

  const html = await response.text();
  const htmlAnalysis = analyzeConfigurePageHtml(html);
  if (!htmlAnalysis.ok) {
    return htmlAnalysis;
  }

  const cssHref = extractNextCssHref(html);
  if (!cssHref) {
    return failure(
      "missing_css_bundle",
      "Page HTML is missing a Next.js CSS bundle link.",
      true,
    );
  }

  const cssUrl = new URL(cssHref, pageUrl).href;
  let cssResponse: Response;
  try {
    cssResponse = await fetch(cssUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      "unexpected_page_error",
      `Could not load CSS asset ${cssHref}: ${message}`,
      false,
    );
  }

  if (!cssResponse.ok) {
    return failure(
      "http_error",
      `CSS asset ${cssHref} returned HTTP ${cssResponse.status}`,
      false,
    );
  }

  const cssBody = await cssResponse.text();
  return validateConfigureCssAsset({
    contentType: cssResponse.headers.get("content-type"),
    body: cssBody,
    href: cssHref,
  });
}

export async function checkConfigurePageHealth(
  configureUrl = CANONICAL_CONFIGURE_URL,
): Promise<ConfigureHealthResult> {
  const result = await checkGuiPageHealth(configureUrl);
  return {
    ok: result.ok,
    reason: result.reason,
  };
}

export async function waitForConfigureServer(
  baseUrl: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `${baseUrl.replace(/\/$/, "")}/`;

  while (Date.now() < deadline) {
    try {
      // Accept root redirects (307/302) as reachability. Destination health is
      // validated separately by checkRuntimeIntegrity / checkGuiPageHealth.
      const response = await fetch(healthUrl, { redirect: "manual" });
      if (
        response.status < 500 ||
        (response.status >= 300 && response.status < 400)
      ) {
        return;
      }
    } catch {
      // Server still starting.
    }

    await sleep(500);
  }

  throw new Error(
    `Harness GUI did not become reachable at ${healthUrl} within ${timeoutMs}ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
