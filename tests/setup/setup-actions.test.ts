import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  previewGitHubSecretInstructions,
  runOperatorScaffold,
} from "../../src/setup/setup-actions.js";
import { resolveLocalFilePaths } from "../../src/setup/setup-state.js";

const ENV_EXAMPLE = `# test example
HARNESS_CONFIG_PATH=.harness/config.local.json
LINEAR_API_KEY=
`;

const CONFIG_EXAMPLE = JSON.stringify(
  {
    version: 1,
    orchestratorMarker: "harness-orchestrator-v1",
    logDirectory: "runs",
    repos: [
      {
        id: "target-app",
        linearProjects: ["Example Target App"],
        targetRepo: "https://github.com/owner/example-target-app",
        baseBranch: "dev",
      },
    ],
    allowedTargetRepos: ["https://github.com/owner/example-target-app"],
  },
  null,
  2,
);

describe("runOperatorScaffold", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-setup-actions-"));
    await writeFile(path.join(tempRoot, ".env.example"), ENV_EXAMPLE, "utf8");
    const harnessDir = path.join(tempRoot, ".harness");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      path.join(harnessDir, "config.example.json"),
      CONFIG_EXAMPLE,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("dry-run does not write local files", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    const { results } = await runOperatorScaffold({
      cwd: tempRoot,
      mode: "dry-run",
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.outcome !== "changed")).toBe(true);

    await expect(access(paths.envLocal)).rejects.toThrow();
    await expect(access(paths.configLocal)).rejects.toThrow();
  });

  it("apply writes only expected local files", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    const { results } = await runOperatorScaffold({
      cwd: tempRoot,
      mode: "apply",
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.outcome === "changed")).toBe(true);

    const envLocal = await readFile(paths.envLocal, "utf8");
    const configLocal = await readFile(paths.configLocal, "utf8");
    expect(envLocal).toContain("HARNESS_CONFIG_PATH=.harness/config.local.json");
    expect(configLocal).toContain('"id": "target-app"');
  });

  it("previewGitHubSecretInstructions does not include secret values", () => {
    const preview = previewGitHubSecretInstructions({
      harnessRepo: "owner/agentic-product-development-harness",
    });

    expect(preview.manualInstructions?.join("\n")).toContain(
      "HARNESS_CONFIG_JSON_B64",
    );
    expect(preview.manualInstructions?.join("\n")).not.toMatch(
      /LINEAR_API_KEY=[^ ]+/,
    );
  });
});
