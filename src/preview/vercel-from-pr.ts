export interface PreviewCaptureResult {
  previewUrl: string | null;
  source: "vercel_comment" | "vercel_url_scan" | null;
  polledSeconds: number;
  warnings: string[];
}

const PREVIEW_LINK_REGEX =
  /\[Preview\]\((https:\/\/[^)]+\.vercel\.app[^)]*)\)/i;
const VERCEL_APP_URL_REGEX = /https:\/\/[a-z0-9-]+\.vercel\.app[^\s)"']*/gi;

export function extractVercelPreviewFromComments(
  comments: { author: string; body: string }[],
): PreviewCaptureResult {
  const vercelComments = comments.filter((comment) =>
    comment.author.toLowerCase().startsWith("vercel"),
  );

  for (const comment of vercelComments) {
    const previewMatch = comment.body.match(PREVIEW_LINK_REGEX);
    if (previewMatch?.[1]) {
      return {
        previewUrl: previewMatch[1],
        source: "vercel_comment",
        polledSeconds: 0,
        warnings: [],
      };
    }
  }

  for (const comment of comments) {
    const matches = comment.body.match(VERCEL_APP_URL_REGEX);
    if (matches?.[0]) {
      return {
        previewUrl: matches[0],
        source: "vercel_url_scan",
        polledSeconds: 0,
        warnings: [],
      };
    }
  }

  return {
    previewUrl: null,
    source: null,
    polledSeconds: 0,
    warnings: ["No Vercel preview URL found in PR comments"],
  };
}

async function fetchCommentsWithDeadline(
  fetchComments: () => Promise<{ author: string; body: string }[]>,
  deadlineMs: number,
): Promise<{ author: string; body: string }[] | null> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchComments(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function pollForVercelPreview(
  fetchComments: () => Promise<{ author: string; body: string }[]>,
  options: {
    pollTimeoutSeconds: number;
    pollIntervalSeconds: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<PreviewCaptureResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + options.pollTimeoutSeconds * 1000;
  let polledSeconds = 0;
  let fetchTimedOut = false;

  while (Date.now() <= deadline) {
    const comments = await fetchCommentsWithDeadline(fetchComments, deadline);
    if (comments === null) {
      fetchTimedOut = true;
      break;
    }

    const result = extractVercelPreviewFromComments(comments);
    if (result.previewUrl) {
      return { ...result, polledSeconds };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }

    const waitMs = Math.min(options.pollIntervalSeconds * 1000, remaining);
    await sleep(waitMs);
    polledSeconds += waitMs / 1000;
  }

  const finalComments = await fetchCommentsWithDeadline(fetchComments, deadline);
  const finalResult = extractVercelPreviewFromComments(finalComments ?? []);
  return {
    ...finalResult,
    polledSeconds,
    warnings: finalResult.previewUrl
      ? []
      : [
          ...(finalResult.warnings ?? []),
          ...(fetchTimedOut ? ["Preview comment fetch timed out before deadline"] : []),
          `Preview not found within ${options.pollTimeoutSeconds}s`,
        ],
  };
}
