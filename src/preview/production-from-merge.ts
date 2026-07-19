import { extractVercelPreviewFromComments } from "./vercel-from-pr.js";

export interface ProductionCaptureResult {
  deploymentUrl: string | null;
  source: "vercel_comment" | "check_details_url" | "config_reference" | null;
  polledSeconds: number;
  warnings: string[];
}

const PRODUCTION_LINK_REGEX =
  /\[Production\]\((https:\/\/[^)]+\.vercel\.app[^)]*)\)/i;
const VERCEL_APP_URL_REGEX = /https:\/\/[a-z0-9-]+\.vercel\.app[^\s)"']*/gi;

export function inferVercelReadyFromComments(
  comments: { author: string; body: string }[],
): boolean {
  const vercelComments = comments.filter((comment) =>
    comment.author.toLowerCase().startsWith("vercel"),
  );

  return vercelComments.some((comment) => {
    const body = comment.body;
    return (
      body.includes("![Ready]") ||
      body.includes("| Ready |") ||
      body.includes("status/ready.svg")
    );
  });
}

export function extractProductionUrlFromComments(
  comments: { author: string; body: string }[],
): string | null {
  const vercelComments = comments.filter((comment) =>
    comment.author.toLowerCase().startsWith("vercel"),
  );

  for (const comment of vercelComments) {
    const productionMatch = comment.body.match(PRODUCTION_LINK_REGEX);
    if (productionMatch?.[1]) {
      return productionMatch[1];
    }
  }

  const previewResult = extractVercelPreviewFromComments(comments);
  if (previewResult.previewUrl && !previewResult.previewUrl.includes("-git-")) {
    return previewResult.previewUrl;
  }

  for (const comment of comments) {
    const matches = comment.body.match(VERCEL_APP_URL_REGEX);
    if (matches?.[0] && !matches[0].includes("-git-")) {
      return matches[0];
    }
  }

  return null;
}

export function extractProductionUrlFromChecks(
  checks: { name: string; detailsUrl: string | null }[],
): string | null {
  for (const check of checks) {
    if (!check.detailsUrl) continue;
    const match = check.detailsUrl.match(VERCEL_APP_URL_REGEX);
    if (match?.[0] && !match[0].includes("-git-")) {
      return match[0];
    }
  }
  return null;
}

export async function pollForProductionDeployment(
  fetchState: () => Promise<{
    comments: { author: string; body: string }[];
    checks: { name: string; detailsUrl: string | null }[];
  }>,
  options: {
    pollTimeoutSeconds: number;
    pollIntervalSeconds: number;
    productionUrlReference?: string | null;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<ProductionCaptureResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + options.pollTimeoutSeconds * 1000;
  let polledSeconds = 0;
  const warnings: string[] = [];

  while (Date.now() <= deadline) {
    const state = await fetchState();
    const fromComments = extractProductionUrlFromComments(state.comments);
    if (fromComments) {
      return {
        deploymentUrl: fromComments,
        source: "vercel_comment",
        polledSeconds,
        warnings: [],
      };
    }

    const fromChecks = extractProductionUrlFromChecks(state.checks);
    if (fromChecks) {
      return {
        deploymentUrl: fromChecks,
        source: "check_details_url",
        polledSeconds,
        warnings: [],
      };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }

    const waitMs = Math.min(options.pollIntervalSeconds * 1000, remaining);
    await sleep(waitMs);
    polledSeconds += waitMs / 1000;
  }

  if (options.productionUrlReference) {
    warnings.push(
      `No live production deployment proof found; including configured reference URL: ${options.productionUrlReference}`,
    );
    return {
      deploymentUrl: options.productionUrlReference,
      source: "config_reference",
      polledSeconds,
      warnings,
    };
  }

  warnings.push(
    `Production deployment URL not found within ${options.pollTimeoutSeconds}s`,
  );
  return {
    deploymentUrl: null,
    source: null,
    polledSeconds,
    warnings,
  };
}
