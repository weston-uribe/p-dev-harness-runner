import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDispatchMetadataFromEnv,
  writeDispatchMetadata,
} from "../../src/workflow/dispatch-metadata.js";

describe("buildDispatchMetadataFromEnv", () => {
  it("maps env keys to payload and strips empty strings", () => {
    const payload = buildDispatchMetadataFromEnv({
      GITHUB_RUN_ID: "123",
      ISSUE_KEY: "WES-1",
      PHASE: "",
      TRIGGER: "linear",
    });

    expect(payload).toEqual({
      githubRunId: "123",
      issueKey: "WES-1",
      trigger: "linear",
    });
    expect(payload).not.toHaveProperty("phase");
  });
});

describe("writeDispatchMetadata", () => {
  it("writes JSON to the given path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-metadata-"));
    const outputPath = join(dir, "nested", "dispatch-metadata.json");

    writeDispatchMetadata(outputPath, { issueKey: "WES-2", phase: "merge" });

    const raw = readFileSync(outputPath, "utf8");
    expect(JSON.parse(raw)).toEqual({ issueKey: "WES-2", phase: "merge" });
  });
});
