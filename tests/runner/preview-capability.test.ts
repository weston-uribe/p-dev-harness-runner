import { describe, expect, it } from "vitest";
import {
  allReposSkipApplicationPreview,
  shouldCaptureApplicationPreview,
} from "../../src/preview/preview-capability.js";

describe("shouldCaptureApplicationPreview", () => {
  it("returns false for none", () => {
    expect(shouldCaptureApplicationPreview("none")).toBe(false);
    expect(shouldCaptureApplicationPreview("NONE")).toBe(false);
    expect(shouldCaptureApplicationPreview(" none ")).toBe(false);
  });

  it("returns false for empty values", () => {
    expect(shouldCaptureApplicationPreview("")).toBe(false);
    expect(shouldCaptureApplicationPreview(undefined)).toBe(false);
    expect(shouldCaptureApplicationPreview(null)).toBe(false);
  });

  it("returns true for vercel and other providers", () => {
    expect(shouldCaptureApplicationPreview("vercel")).toBe(true);
    expect(shouldCaptureApplicationPreview("custom")).toBe(true);
  });
});

describe("allReposSkipApplicationPreview", () => {
  it("returns false when repos are missing", () => {
    expect(allReposSkipApplicationPreview(undefined)).toBe(false);
    expect(allReposSkipApplicationPreview([])).toBe(false);
  });

  it("returns true only when every repo skips application preview", () => {
    expect(
      allReposSkipApplicationPreview([
        { previewProvider: "none" },
        { previewProvider: "none" },
      ]),
    ).toBe(true);
    expect(
      allReposSkipApplicationPreview([
        { previewProvider: "none" },
        { previewProvider: "vercel" },
      ]),
    ).toBe(false);
  });
});
