import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRedactJsonFileCommand } from "../../src/cli/commands/redact-json-file.js";

describe("sync-production --json-out / redact-json-file", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "sync-json-out-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("redacts secrets and keeps complete parseable JSON", async () => {
    const inputPath = path.join(tempRoot, "raw.json");
    const outputPath = path.join(tempRoot, "out.json");
    const payload = {
      trigger: "repository_dispatch",
      repoId: "portfolio",
      productionBranch: "main",
      after: "abc123",
      issuesInspected: 1,
      issuesUpdated: 0,
      issuesSkipped: 1,
      issuesFailed: 0,
      results: [
        {
          issueKey: "FRE-6",
          finalOutcome: "duplicate",
          productionCompletionId: "deadbeef",
          token: "lin_api_SECRETVALUE1234567890",
        },
      ],
    };
    await writeFile(inputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    // Simulate stderr noise that must not enter the JSON file
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    console.error("npm warn unrelated banner");

    const code = await runRedactJsonFileCommand({
      inputPath,
      outputPath,
    });
    expect(code).toBe(0);
    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as typeof payload;
    expect(parsed.repoId).toBe("portfolio");
    expect(parsed.results[0]?.productionCompletionId).toBe("deadbeef");
    expect(JSON.stringify(parsed)).not.toContain("lin_api_SECRETVALUE");
    expect(JSON.stringify(parsed)).toContain("[REDACTED]");
    expect(raw).not.toContain("npm warn");
    errSpy.mockRestore();
  });

  it("fails closed on invalid machine JSON", async () => {
    const inputPath = path.join(tempRoot, "bad.json");
    const outputPath = path.join(tempRoot, "out.json");
    await writeFile(inputPath, "npm warn\nnot-json\n", "utf8");
    const code = await runRedactJsonFileCommand({
      inputPath,
      outputPath,
    });
    expect(code).not.toBe(0);
  });
});
