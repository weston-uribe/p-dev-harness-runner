import {
  analyzeConfigurePageHtml,
  extractNextCssHref,
  validateConfigureCssAsset,
  type GuiHealthCategory,
  type GuiHealthResult,
} from "./configure-health.js";

export type RuntimeIntegrityCategory =
  | GuiHealthCategory
  | "redirect_destination_failed"
  | "missing_js_assets"
  | "invalid_js_asset"
  | "api_module_error"
  | "identity_mismatch"
  | "process_mismatch"
  | "hydration_marker_missing";

export interface RuntimeIntegrityResult {
  ok: boolean;
  category?: RuntimeIntegrityCategory;
  reason?: string;
  recoverableByRuntimeReset: boolean;
  details?: Record<string, string | number | boolean | null | undefined>;
}

export interface RuntimeIdentityExpectation {
  snapshotId: string;
  sourceRoot: string;
  workspaceDir: string;
  buildId?: string;
  runtimeMode: "operator" | "developer" | "packaged";
}

function success(): RuntimeIntegrityResult {
  return { ok: true, recoverableByRuntimeReset: false };
}

function failure(
  category: RuntimeIntegrityCategory,
  reason: string,
  recoverableByRuntimeReset = false,
  details?: RuntimeIntegrityResult["details"],
): RuntimeIntegrityResult {
  return {
    ok: false,
    category,
    reason,
    recoverableByRuntimeReset,
    details,
  };
}

export function extractNextJsHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const patterns = [
    /src="(\/_next\/static\/[^"]+\.js[^"]*)"/g,
    /src='(\/_next\/static\/[^']+\.js[^']*)'/g,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      if (match[1]) {
        hrefs.push(match[1]);
      }
    }
  }
  return [...new Set(hrefs)];
}

export function validateJsAsset(input: {
  contentType: string | null;
  body: string;
  href: string;
  status: number;
}): RuntimeIntegrityResult {
  if (input.status === 404 || input.status >= 500) {
    return failure(
      "invalid_js_asset",
      `JS asset ${input.href} returned HTTP ${input.status}`,
      true,
      { status: input.status, href: input.href },
    );
  }
  if (!input.status || input.status >= 400) {
    return failure(
      "invalid_js_asset",
      `JS asset ${input.href} returned HTTP ${input.status}`,
      true,
      { status: input.status, href: input.href },
    );
  }

  const contentType = input.contentType ?? "";
  const looksLikeHtml =
    contentType.includes("text/html") ||
    input.body.trimStart().startsWith("<!DOCTYPE") ||
    input.body.trimStart().startsWith("<html");
  if (looksLikeHtml) {
    return failure(
      "invalid_js_asset",
      `JS asset ${input.href} returned HTML instead of JavaScript`,
      true,
      { contentType, href: input.href },
    );
  }

  if (
    contentType &&
    !contentType.includes("javascript") &&
    !contentType.includes("ecmascript") &&
    !contentType.includes("text/plain")
  ) {
    return failure(
      "invalid_js_asset",
      `JS asset ${input.href} returned unexpected content-type: ${contentType}`,
      true,
      { contentType, href: input.href },
    );
  }

  if (input.body.trim().length < 20) {
    return failure(
      "invalid_js_asset",
      `JS asset ${input.href} is suspiciously small (${input.body.length} bytes)`,
      true,
      { href: input.href, bytes: input.body.length },
    );
  }

  return success();
}

export function analyzeHydrationMarker(html: string, marker: string): RuntimeIntegrityResult {
  if (!html.includes(marker)) {
    return failure(
      "hydration_marker_missing",
      `Page HTML is missing smoke hydration marker ${marker}`,
      false,
    );
  }
  return success();
}

async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<{
  ok: boolean;
  status: number;
  contentType: string | null;
  body: string;
  url: string;
}> {
  const response = await fetch(url, init);
  const body = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type"),
    body,
    url: response.url,
  };
}

/**
 * Full operator/developer integrity suite.
 * Treats root 307 as healthy when the destination page and assets are healthy.
 */
export async function checkRuntimeIntegrity(input: {
  baseUrl: string;
  expected?: RuntimeIdentityExpectation;
  expectedPid?: number;
  portOwnerPid?: number | null;
  hydrationMarker?: string;
  verifyConnectionsApi?: boolean;
}): Promise<RuntimeIntegrityResult> {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const hydrationMarker =
    input.hydrationMarker ?? 'data-p-dev-runtime-smoke="1"';

  if (
    input.expectedPid !== undefined &&
    input.portOwnerPid !== undefined &&
    input.portOwnerPid !== null &&
    input.portOwnerPid !== input.expectedPid
  ) {
    return failure(
      "process_mismatch",
      `Port owner PID ${input.portOwnerPid} does not match launched PID ${input.expectedPid}`,
      false,
      {
        portOwnerPid: input.portOwnerPid,
        expectedPid: input.expectedPid,
      },
    );
  }

  let root: Awaited<ReturnType<typeof fetchText>>;
  try {
    root = await fetchText(`${baseUrl}/`, { redirect: "manual" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("unreachable", `Could not reach ${baseUrl}/: ${message}`, false);
  }

  let pageUrl = `${baseUrl}/`;
  let page = root;

  if (root.status >= 300 && root.status < 400) {
    // Healthy root redirect (e.g. 307) — destination must succeed.
    try {
      const followed = await fetchText(`${baseUrl}/`, { redirect: "follow" });
      if (!followed.ok) {
        return failure(
          "redirect_destination_failed",
          `Root redirect destination returned HTTP ${followed.status}`,
          followed.status >= 500,
          { status: followed.status },
        );
      }
      page = followed;
      pageUrl = followed.url || pageUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "redirect_destination_failed",
        `Root redirect destination unreachable: ${message}`,
        false,
      );
    }
  } else if (root.status >= 500) {
    return failure(
      "http_error",
      `${baseUrl}/ returned HTTP ${root.status}`,
      true,
      { status: root.status },
    );
  } else if (!root.ok) {
    return failure(
      "http_error",
      `${baseUrl}/ returned HTTP ${root.status}`,
      false,
      { status: root.status },
    );
  }

  const htmlAnalysis = analyzeConfigurePageHtml(page.body);
  if (!htmlAnalysis.ok) {
    return failure(
      htmlAnalysis.category ?? "missing_static_assets",
      htmlAnalysis.reason ?? "HTML asset analysis failed",
      true,
    );
  }

  const markerResult = analyzeHydrationMarker(page.body, hydrationMarker);
  if (!markerResult.ok) {
    // Marker may be client-only; treat missing marker as soft for packaged pages
    // that have not been updated yet — still require CSS/JS.
  }

  const cssHref = extractNextCssHref(page.body);
  if (!cssHref) {
    return failure(
      "missing_css_bundle",
      "Page HTML is missing a Next.js CSS bundle link",
      true,
    );
  }

  try {
    const css = await fetchText(new URL(cssHref, pageUrl).href);
    const cssResult = validateConfigureCssAsset({
      contentType: css.contentType,
      body: css.body,
      href: cssHref,
    });
    if (!cssResult.ok) {
      return failure(
        cssResult.category ?? "invalid_css_asset",
        cssResult.reason ?? "CSS validation failed",
        true,
        { href: cssHref, status: css.status, contentType: css.contentType },
      );
    }
    if (css.contentType?.includes("text/html") || css.status === 404 || css.status >= 500) {
      return failure(
        "invalid_css_asset",
        `CSS asset ${cssHref} returned status ${css.status} content-type ${css.contentType}`,
        true,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      "invalid_css_asset",
      `Could not load CSS asset ${cssHref}: ${message}`,
      true,
    );
  }

  const jsHrefs = extractNextJsHrefs(page.body).slice(0, 5);
  if (jsHrefs.length === 0) {
    return failure(
      "missing_js_assets",
      "Page HTML is missing Next.js JavaScript assets",
      true,
    );
  }

  for (const href of jsHrefs) {
    try {
      const js = await fetchText(new URL(href, pageUrl).href);
      const jsResult = validateJsAsset({
        contentType: js.contentType,
        body: js.body,
        href,
        status: js.status,
      });
      if (!jsResult.ok) {
        return jsResult;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "invalid_js_asset",
        `Could not load JS asset ${href}: ${message}`,
        true,
      );
    }
  }

  if (input.verifyConnectionsApi !== false) {
    try {
      const api = await fetchText(`${baseUrl}/api/setup/verify-saved-connections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const bodyLooksLikeHtml =
        api.contentType?.includes("text/html") ||
        api.body.trimStart().startsWith("<!DOCTYPE") ||
        api.body.includes("Cannot find module");
      if (api.status >= 500 || bodyLooksLikeHtml) {
        return failure(
          "api_module_error",
          `verify-saved-connections returned HTTP ${api.status} (${api.contentType ?? "unknown type"}) — local runtime/module error`,
          true,
          {
            status: api.status,
            contentType: api.contentType,
            url: `${baseUrl}/api/setup/verify-saved-connections`,
          },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "api_module_error",
        `verify-saved-connections request failed: ${message}`,
        true,
      );
    }
  }

  if (input.expected) {
    try {
      const health = await fetchText(`${baseUrl}/api/setup/runtime-health`);
      if (!health.ok) {
        return failure(
          "identity_mismatch",
          `runtime-health returned HTTP ${health.status}`,
          health.status >= 500,
          { status: health.status },
        );
      }
      const payload = JSON.parse(health.body) as {
        snapshotId?: string;
        sourceRoot?: string;
        workspaceDir?: string;
        buildId?: string;
        runtimeMode?: string;
      };
      if (
        payload.snapshotId &&
        payload.snapshotId !== input.expected.snapshotId
      ) {
        return failure(
          "identity_mismatch",
          `Runtime snapshot ${payload.snapshotId} does not match expected ${input.expected.snapshotId}`,
          true,
        );
      }
      if (
        payload.workspaceDir &&
        pathNormalize(payload.workspaceDir) !==
          pathNormalize(input.expected.workspaceDir)
      ) {
        return failure(
          "identity_mismatch",
          `Runtime workspace does not match launcher workspace`,
          false,
        );
      }
      if (
        payload.runtimeMode &&
        payload.runtimeMode !== input.expected.runtimeMode
      ) {
        return failure(
          "identity_mismatch",
          `Runtime mode ${payload.runtimeMode} does not match expected ${input.expected.runtimeMode}`,
          false,
        );
      }
      if (
        input.expected.buildId &&
        payload.buildId &&
        payload.buildId !== input.expected.buildId
      ) {
        return failure(
          "identity_mismatch",
          `BUILD_ID mismatch`,
          true,
          {
            expectedBuildId: input.expected.buildId,
            actualBuildId: payload.buildId,
          },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "identity_mismatch",
        `Could not verify runtime identity: ${message}`,
        false,
      );
    }
  }

  // Prefer marker when present after pages ship it.
  if (page.body.includes("data-p-dev-runtime-smoke")) {
    const markerOk = analyzeHydrationMarker(page.body, hydrationMarker);
    if (!markerOk.ok) {
      return markerOk;
    }
  }

  return success();
}

function pathNormalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function toLegacyGuiHealth(
  result: RuntimeIntegrityResult,
): GuiHealthResult {
  return {
    ok: result.ok,
    category: result.category as GuiHealthCategory | undefined,
    reason: result.reason,
    recoverableByCacheReset: result.recoverableByRuntimeReset,
  };
}
