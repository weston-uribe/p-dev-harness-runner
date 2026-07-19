import { describe, expect, it } from "vitest";
import {
  buildCursorCloudRunUrl,
  formatCursorCloudRunLink,
} from "../../src/cursor/urls.js";

describe("buildCursorCloudRunUrl", () => {
  it("builds agent URL without run id", () => {
    expect(buildCursorCloudRunUrl("bc-agent-123")).toBe(
      "https://cursor.com/agents/bc-agent-123",
    );
  });

  it("includes run query param when provided", () => {
    expect(buildCursorCloudRunUrl("bc-agent-123", "run-456")).toBe(
      "https://cursor.com/agents/bc-agent-123?run=run-456",
    );
  });
});

describe("formatCursorCloudRunLink", () => {
  it("formats markdown link", () => {
    expect(formatCursorCloudRunLink("bc-agent-123", "run-456")).toBe(
      "[Cursor Cloud run](https://cursor.com/agents/bc-agent-123?run=run-456)",
    );
  });
});
