import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  formatHarnessMetadataBlock,
  parseHarnessProjectMetadata,
  upsertHarnessMetadataInDescription,
} from "../../src/linear/project-harness-metadata.js";
import { syncProjectHarnessMetadataAfterFoundationMerge } from "../../src/linear/project-metadata-sync.js";

vi.mock("../../src/product/read-product-marker.js", () => ({
  readProductMarker: vi.fn(),
}));

import { readProductMarker } from "../../src/product/read-product-marker.js";

describe("project harness metadata", () => {
  it("parses and formats harness metadata block", () => {
    const description = `Project notes

Harness metadata:
Target repo: owner/repo
Product initialization: uninitialized
`;
    expect(parseHarnessProjectMetadata(description)).toEqual({
      targetRepo: "owner/repo",
      productInitialization: "uninitialized",
    });
    expect(
      formatHarnessMetadataBlock({
        targetRepo: "owner/repo",
        productInitialization: "initialized",
      }),
    ).toBe(
      "Harness metadata:\nTarget repo: owner/repo\nProduct initialization: initialized",
    );
  });

  it("upserts metadata without duplicating the block", () => {
    const updated = upsertHarnessMetadataInDescription(
      "Harness metadata:\nTarget repo: owner/repo\nProduct initialization: uninitialized\n",
      { productInitialization: "initialized" },
    );
    expect(updated).toContain("Product initialization: initialized");
    expect(updated.match(/Harness metadata:/g)?.length).toBe(1);
  });
});

describe("syncProjectHarnessMetadataAfterFoundationMerge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates project description when marker is initialized", async () => {
    const marker = {
      schemaVersion: 1,
      createdBy: "p-dev",
      initializationStatus: "initialized",
      createdAt: "2026-07-16T23:22:00.000Z",
      operationId: "op-1",
      creationActionId: "action-1",
      approvedArchitecture: {
        platformRuntime: "Node.js",
        languageFramework: "TypeScript",
      },
    };
    vi.mocked(readProductMarker).mockResolvedValue({
      content: `${JSON.stringify(marker)}\n`,
      markerPath: ".p-dev/product.json",
      developmentBranch: "dev",
    });

    const updateProject = vi.fn();
    const result = await syncProjectHarnessMetadataAfterFoundationMerge({
      linearClient: { updateProject } as never,
      projectId: "project-1",
      currentDescription:
        "Harness metadata:\nTarget repo: owner/repo\nProduct initialization: uninitialized\n",
      targetRepo: "https://github.com/owner/repo",
      developmentBranch: "dev",
      github: {} as never,
      orchestratorMarker: "harness-orchestrator-v1",
      mergeRunId: "merge-run-1",
      comments: [],
    });

    expect(result.updated).toBe(true);
    expect(updateProject).toHaveBeenCalledWith("project-1", {
      description: expect.stringContaining("Product initialization: initialized"),
    });
  });
});
