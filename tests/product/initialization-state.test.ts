import { describe, expect, it } from "vitest";
import {
  buildUninitializedProductMarker,
  serializeProductMarker,
} from "../../src/product/product-marker.js";
import {
  blocksDirectImplementationForInitialization,
  resolveProductInitializationState,
} from "../../src/product/initialization-state.js";

describe("resolveProductInitializationState", () => {
  it("returns missing_marker when content is null", () => {
    expect(resolveProductInitializationState(null)).toEqual({
      state: "missing_marker",
      hasApprovedArchitecture: false,
      reason: "Product marker not found on development branch.",
    });
  });

  it("returns invalid_marker for malformed JSON", () => {
    const result = resolveProductInitializationState("{not-json");
    expect(result.state).toBe("invalid_marker");
    expect(result.hasApprovedArchitecture).toBe(false);
  });

  it("returns uninitialized without approved architecture", () => {
    const marker = buildUninitializedProductMarker({
      createdAt: "2026-07-16T23:22:00.000Z",
      operationId: "op-1",
      creationActionId: "action-1",
    });
    const result = resolveProductInitializationState(serializeProductMarker(marker));
    expect(result).toEqual({
      state: "uninitialized",
      hasApprovedArchitecture: false,
    });
  });

  it("returns initialized for initialized marker status", () => {
    const marker = {
      schemaVersion: 1 as const,
      createdBy: "p-dev" as const,
      initializationStatus: "initialized" as const,
      createdAt: "2026-07-16T23:22:00.000Z",
      operationId: "op-1",
      creationActionId: "action-1",
      approvedArchitecture: {
        platformRuntime: "Node.js",
        languageFramework: "TypeScript",
      },
    };
    const result = resolveProductInitializationState(
      `${JSON.stringify(marker, null, 2)}\n`,
    );
    expect(result.state).toBe("initialized");
    expect(result.hasApprovedArchitecture).toBe(true);
  });
});

describe("blocksDirectImplementationForInitialization", () => {
  it("blocks uninitialized products", () => {
    expect(
      blocksDirectImplementationForInitialization({
        state: "uninitialized",
        hasApprovedArchitecture: false,
      }),
    ).toBe(true);
  });

  it("does not block initialized products", () => {
    expect(
      blocksDirectImplementationForInitialization({
        state: "initialized",
        hasApprovedArchitecture: true,
      }),
    ).toBe(false);
  });
});
