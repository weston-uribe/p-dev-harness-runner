import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harnessConfigSchema } from "../../src/config/schema.js";
import {
  buildExampleTargetAppConfig,
  buildHarnessConfigJson,
} from "../../src/setup/config-builder.js";
import { writeConfigLocal } from "../../src/setup/config-writer.js";
import { resolveLocalFilePaths } from "../../src/setup/setup-state.js";

describe("config-builder", () => {
  it("builds config with generic target repo placeholders", () => {
    const config = buildExampleTargetAppConfig();

    expect(config.repos[0]?.id).toBe("target-app");
    expect(config.repos[0]?.targetRepo).toBe(
      "https://github.com/owner/example-target-app",
    );
    expect(config.repos[0]?.linearProjects).toEqual(["Example Target App"]);
    expect(config.agentProvider?.id).toBe("cursor");
    expect(config.agentProvider?.model?.id).toBe("composer-2.5");
    expect(config.defaultModel?.id).toBe("composer-2.5");
    expect(config.workflow?.optionalPhases).toEqual({
      planReview: true,
      codeReview: true,
    });
    expect(config.workflow?.cycleLimits).toEqual({
      planReview: 4,
      codeReview: 4,
    });
    expect(config.roleModels).toMatchObject({
      planner: { id: "composer-2.5" },
      builder: { id: "composer-2.5" },
      planReviewer: { id: "composer-2.5" },
      codeReviewer: { id: "composer-2.5" },
      codeReviser: { id: "composer-2.5" },
    });
    expect(harnessConfigSchema.safeParse(config).success).toBe(true);
  });

  it("formats stable JSON with trailing newline", () => {
    const json = buildHarnessConfigJson({
      repos: [
        {
          id: "target-app",
          linearProjects: ["Example Target App"],
          targetRepo: "https://github.com/owner/example-target-app",
        },
      ],
    });

    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain('"id": "target-app"');
  });
});

describe("writeConfigLocal", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-config-writer-"));
    const paths = resolveLocalFilePaths(tempRoot);
    await mkdir(paths.harnessDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("dry-run does not write config.local.json", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    const result = await writeConfigLocal({
      paths,
      mode: "dry-run",
      input: {
        repos: [
          {
            id: "target-app",
            linearProjects: ["Example Target App"],
            targetRepo: "https://github.com/owner/example-target-app",
          },
        ],
      },
    });

    expect(result.outcome).toBe("preview");
    await expect(access(paths.configLocal)).rejects.toThrow();
  });

  it("apply writes only .harness/config.local.json", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    const result = await writeConfigLocal({
      paths,
      mode: "apply",
      input: {
        repos: [
          {
            id: "target-app",
            linearProjects: ["Example Target App"],
            targetRepo: "https://github.com/owner/example-target-app",
          },
        ],
      },
    });

    expect(result.outcome).toBe("changed");
    const configLocal = await readFile(paths.configLocal, "utf8");
    expect(configLocal).toContain('"id": "target-app"');
    await expect(access(paths.envLocal)).rejects.toThrow();
  });

  it("skips existing config unless force is set", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    await writeFile(paths.configLocal, "SENTINEL_CONFIG", "utf8");

    const skipped = await writeConfigLocal({
      paths,
      mode: "apply",
      input: {
        repos: [
          {
            id: "target-app",
            targetRepo: "https://github.com/owner/example-target-app",
          },
        ],
      },
    });

    expect(skipped.outcome).toBe("skipped");
    expect(await readFile(paths.configLocal, "utf8")).toBe("SENTINEL_CONFIG");

    const forced = await writeConfigLocal({
      paths,
      force: true,
      mode: "apply",
      input: {
        repos: [
          {
            id: "target-app",
            targetRepo: "https://github.com/owner/example-target-app",
          },
        ],
      },
    });

    expect(forced.outcome).toBe("changed");
    expect(await readFile(paths.configLocal, "utf8")).toContain('"id": "target-app"');
  });
});
