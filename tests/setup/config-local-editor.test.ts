import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmptyConfigFormInput,
  isExampleHarnessConfig,
  isExampleTemplateValue,
  loadConfigFormDefaults,
  normalizeConfigFormInput,
  validateConfigFormInput,
} from "../../src/setup/config-local-editor.js";
import {
  deriveRepoConfigIdFromUrl,
  prepareGuidedConfigFormInput,
} from "../../src/setup/guided-config-form.js";
import { buildExampleTargetAppConfig } from "../../src/setup/config-builder.js";

describe("config-local-editor", () => {
  it("normalizes comma-separated linear projects and newline commands", () => {
    const normalized = normalizeConfigFormInput({
      linearTeamKey: "WES",
      modelId: "composer-2.5",
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
          linearProjects: "App One, App Two",
          linearTeams: "Team A\nTeam B",
          validationCommands: "npm run lint\nnpm run build",
        },
      ],
    });

    expect(normalized.repos[0]?.linearProjects).toEqual(["App One", "App Two"]);
    expect(normalized.repos[0]?.linearTeams).toEqual(["Team A", "Team B"]);
    expect(normalized.repos[0]?.validationCommands).toEqual([
      "npm run lint",
      "npm run build",
    ]);
    expect(normalized.allowedTargetRepos).toBeUndefined();
  });

  it("generates allowedTargetRepos closure from repo mappings", () => {
    const { config } = validateConfigFormInput({
      repos: [
        {
          id: "target-app",
          targetRepo: "https://github.com/owner/example-target-app",
        },
      ],
    });

    expect(config.allowedTargetRepos).toEqual([
      "https://github.com/owner/example-target-app",
    ]);
  });

  it("rejects invalid config before write", () => {
    expect(() =>
      validateConfigFormInput({
        repos: [
          {
            id: "",
            targetRepo: "not-a-valid-url",
          },
        ],
      }),
    ).toThrow();
  });

  it("requires at least one repo", () => {
    expect(() =>
      normalizeConfigFormInput({
        repos: [],
      }),
    ).toThrow(/At least one target repo/);
  });

  it("returns empty first-run defaults when no operator config exists", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "harness-config-defaults-"));
    try {
      const defaults = await loadConfigFormDefaults({ cwd: tempRoot });
      expect(defaults).toEqual(createEmptyConfigFormInput());
      expect(JSON.stringify(defaults)).not.toContain("example-target-app");
      expect(JSON.stringify(defaults)).not.toContain("target-app");
      expect(JSON.stringify(defaults)).not.toContain("Example Target App");
      expect(JSON.stringify(defaults)).not.toContain("staging.example.com");
      expect(JSON.stringify(defaults)).not.toContain("example.com");
      expect(defaults.linearTeamKey).toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads real operator config.local.json values into the form", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "harness-config-operator-"));
    try {
      const harnessDir = path.join(tempRoot, ".harness");
      await mkdir(harnessDir, { recursive: true });
      await writeFile(
        path.join(tempRoot, ".env.local"),
        "HARNESS_CONFIG_PATH=.harness/config.local.json\n",
        "utf8",
      );
      await writeFile(
        path.join(harnessDir, "config.local.json"),
        JSON.stringify(
          {
            version: 1,
            repos: [
              {
                id: "my-real-app",
                targetRepo: "https://github.com/acme/my-real-app",
              },
            ],
            allowedTargetRepos: ["https://github.com/acme/my-real-app"],
          },
          null,
          2,
        ),
        "utf8",
      );

      const defaults = await loadConfigFormDefaults({ cwd: tempRoot });
      expect(defaults.repos[0]?.id).toBe("my-real-app");
      expect(defaults.repos[0]?.targetRepo).toBe(
        "https://github.com/acme/my-real-app",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("derives repo config id from target repo URL for guided mode", () => {
    expect(
      deriveRepoConfigIdFromUrl("https://github.com/acme/my-product"),
    ).toBe("my-product");
    expect(prepareGuidedConfigFormInput({
      repos: [{ id: "", targetRepo: "https://github.com/acme/my-product" }],
    }).repos[0]?.id).toBe("my-product");
  });

  it("builds valid config from minimal guided input", () => {
    const { config } = validateConfigFormInput(
      prepareGuidedConfigFormInput({
        repos: [{ id: "", targetRepo: "https://github.com/acme/my-product" }],
      }),
    );

    expect(config.repos[0]?.id).toBe("my-product");
    expect(config.allowedTargetRepos).toEqual([
      "https://github.com/acme/my-product",
    ]);
  });

  it("detects example harness config values", () => {
    expect(isExampleHarnessConfig(buildExampleTargetAppConfig())).toBe(true);
    expect(isExampleTemplateValue("https://github.com/owner/example-target-app")).toBe(
      true,
    );
    expect(isExampleTemplateValue("WES")).toBe(true);
  });
});
