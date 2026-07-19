import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load-config.js";
import { harnessConfigSchema } from "../../src/config/schema.js";

const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/config",
);

function minimalConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "target-app",
        linearProjects: ["Example Target App"],
        targetRepo: "https://github.com/owner/example-target-app",
        baseBranch: "main",
      },
    ],
    allowedTargetRepos: [
      "https://github.com/owner/example-target-app",
    ],
    ...overrides,
  };
}

describe("harness config schema", () => {
  it("accepts minimal valid config", async () => {
    const raw = await readFile(path.join(fixturesDir, "minimal.json"), "utf8");
    const parsed = harnessConfigSchema.parse(JSON.parse(raw));
    expect(parsed.repos).toHaveLength(1);
  });

  it("accepts config with only defaultModel", () => {
    const parsed = harnessConfigSchema.parse(
      minimalConfig({ defaultModel: { id: "composer-2.5" } }),
    );
    expect(parsed.defaultModel?.id).toBe("composer-2.5");
    expect(parsed.agentProvider).toBeUndefined();
  });

  it("accepts config with agentProvider.model.id", () => {
    const parsed = harnessConfigSchema.parse(
      minimalConfig({
        agentProvider: { id: "cursor", model: { id: "composer-2.5" } },
      }),
    );
    expect(parsed.agentProvider?.id).toBe("cursor");
    expect(parsed.agentProvider?.model?.id).toBe("composer-2.5");
  });

  it("rejects agentProvider.id values other than cursor", () => {
    const result = harnessConfigSchema.safeParse(
      minimalConfig({
        agentProvider: { id: "claude-code", model: { id: "composer-2.5" } },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("validates the repo harness.config.json", async () => {
    const raw = await readFile(
      path.join(repoRoot, "harness.config.json"),
      "utf8",
    );
    const parsed = harnessConfigSchema.parse(JSON.parse(raw));
    expect(parsed.agentProvider?.id).toBe("cursor");
    expect(parsed.agentProvider?.model?.id).toBe("composer-2.5");
    expect(parsed.defaultModel?.id).toBe("composer-2.5");
  });

  it("rejects unknown top-level keys", () => {
    const result = harnessConfigSchema.safeParse({
      version: 1,
      repos: [],
      allowedTargetRepos: ["https://github.com/o/r"],
      unexpected: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects repo mapping not in allowlist via loadConfig closure", async () => {
    const configPath = path.join(fixturesDir, "minimal.json");
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    raw.repos[0].targetRepo = "https://github.com/other/forbidden";
    const tempDir = await mkdtemp(path.join(tmpdir(), "harness-config-"));
    const tempPath = path.join(tempDir, "invalid-allowlist.json");
    await writeFile(tempPath, JSON.stringify(raw), "utf8");

    await expect(loadConfig(tempPath)).rejects.toThrow(
      /not listed in allowedTargetRepos/,
    );

    await rm(tempDir, { recursive: true, force: true });
  });
});
