import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  extractVercelPreviewFromComments,
  pollForVercelPreview,
} from "../../src/preview/vercel-from-pr.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/github",
);

describe("extractVercelPreviewFromComments", () => {
  it("extracts Preview link from PR #4 Vercel comment fixture", async () => {
    const raw = await readFile(
      path.join(fixturesDir, "pr-4-vercel-comment.json"),
      "utf8",
    );
    const fixture = JSON.parse(raw) as {
      comments: { author: string; body: string }[];
      expectedPreviewUrl: string;
    };

    const result = extractVercelPreviewFromComments(fixture.comments);

    expect(result.previewUrl).toBe(fixture.expectedPreviewUrl);
    expect(result.source).toBe("vercel_comment");
  });

  it("falls back to scanning any comment for vercel.app URLs", () => {
    const result = extractVercelPreviewFromComments([
      {
        author: "some-bot",
        body: "Deploy at https://example-app-git-feature-team.vercel.app done",
      },
    ]);

    expect(result.previewUrl).toBe(
      "https://example-app-git-feature-team.vercel.app",
    );
    expect(result.source).toBe("vercel_url_scan");
  });

  it("returns null when no preview is found", () => {
    const result = extractVercelPreviewFromComments([
      { author: "user", body: "Looks good" },
    ]);

    expect(result.previewUrl).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("pollForVercelPreview", () => {
  it("returns null with timeout warning when preview never appears", async () => {
    const fetchComments = vi.fn().mockResolvedValue([
      { author: "user", body: "No preview yet" },
    ]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollForVercelPreview(fetchComments, {
      pollTimeoutSeconds: 0,
      pollIntervalSeconds: 1,
      sleep,
    });

    expect(result.previewUrl).toBeNull();
    expect(result.warnings.some((w) => w.includes("Preview not found"))).toBe(
      true,
    );
    expect(fetchComments.mock.calls.length).toBeGreaterThanOrEqual(0);
  });

  it("returns preview when it appears during polling", async () => {
    const previewUrl =
      "https://staging-git-cursor-example.vercel.app";
    const fetchComments = vi
      .fn()
      .mockResolvedValueOnce([{ author: "user", body: "Waiting..." }])
      .mockResolvedValueOnce([
        {
          author: "vercel[bot]",
          body: `[Preview](${previewUrl})`,
        },
      ]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollForVercelPreview(fetchComments, {
      pollTimeoutSeconds: 5,
      pollIntervalSeconds: 1,
      sleep,
    });

    expect(result.previewUrl).toBe(previewUrl);
    expect(sleep).toHaveBeenCalled();
  });

  it("does not hang when fetchComments never resolves", async () => {
    vi.useFakeTimers();
    const fetchComments = vi.fn().mockImplementation(
      () => new Promise<{ author: string; body: string }[]>(() => undefined),
    );

    const resultPromise = pollForVercelPreview(fetchComments, {
      pollTimeoutSeconds: 2,
      pollIntervalSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    const result = await resultPromise;

    expect(result.previewUrl).toBeNull();
    expect(
      result.warnings.some((warning) => warning.includes("timed out")),
    ).toBe(true);
    vi.useRealTimers();
  });
});
