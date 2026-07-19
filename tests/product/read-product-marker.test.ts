import { describe, expect, it, vi } from "vitest";
import { PRODUCT_MARKER_PATH } from "../../src/product/product-marker.js";
import { readProductMarker } from "../../src/product/read-product-marker.js";
import type { GitHubClient } from "../../src/github/client.js";

describe("readProductMarker", () => {
  it("reads marker content from development branch via GitHub client", async () => {
    const markerContent = '{"initializationStatus":"uninitialized"}\n';
    const github = {
      getRepositoryContent: vi.fn().mockResolvedValue({
        content: Buffer.from(markerContent).toString("base64"),
      }),
      decodeRepositoryContent: vi.fn().mockReturnValue(markerContent),
    } satisfies Pick<GitHubClient, "getRepositoryContent" | "decodeRepositoryContent">;

    const result = await readProductMarker({
      targetRepo: "https://github.com/test-user/my-product",
      developmentBranch: "dev",
      github: github as GitHubClient,
    });

    expect(github.getRepositoryContent).toHaveBeenCalledWith(
      "test-user",
      "my-product",
      PRODUCT_MARKER_PATH,
      "dev",
    );
    expect(result.markerPath).toBe(PRODUCT_MARKER_PATH);
    expect(result.developmentBranch).toBe("dev");
    expect(result.content).toBe(markerContent);
  });

  it("returns null content when marker is missing", async () => {
    const github = {
      getRepositoryContent: vi.fn().mockResolvedValue(null),
      decodeRepositoryContent: vi.fn(),
    } satisfies Pick<GitHubClient, "getRepositoryContent" | "decodeRepositoryContent">;

    const result = await readProductMarker({
      targetRepo: "owner/empty-product",
      github: github as GitHubClient,
    });

    expect(result.content).toBeNull();
  });
});
