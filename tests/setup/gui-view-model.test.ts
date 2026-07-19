import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectLocalDoctorChecks,
  getSetupStateSummary,
  summarizeEnvKeyPresence,
} from "../../src/setup/gui-view-model.js";

function buildConfigExample(repoId: string): string {
  return JSON.stringify(
    {
      version: 1,
      orchestratorMarker: "harness-orchestrator-v1",
      logDirectory: "runs",
      repos: [
        {
          id: repoId,
          linearProjects: ["Example Target App"],
          targetRepo: "https://github.com/owner/example-target-app",
          baseBranch: "dev",
          productionBranch: "main",
        },
      ],
      allowedTargetRepos: ["https://github.com/owner/example-target-app"],
    },
    null,
    2,
  );
}

const CONFIG_EXAMPLE = buildConfigExample("target-app");

describe("gui-view-model", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-gui-summary-"));
    await writeFile(
      path.join(tempRoot, "harness.config.json"),
      CONFIG_EXAMPLE,
      "utf8",
    );
    await writeFile(
      path.join(tempRoot, ".env.example"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\nLINEAR_API_KEY=\n",
      "utf8",
    );
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

  it("summarizes env key presence without reading secret values into output", async () => {
    const envPath = path.join(tempRoot, ".env.local");
    await writeFile(
      envPath,
      [
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "LINEAR_API_KEY=super-secret-linear",
        "CURSOR_API_KEY=",
      ].join("\n"),
      "utf8",
    );

    const presence = await summarizeEnvKeyPresence(envPath);

    expect(presence.HARNESS_CONFIG_PATH).toBe(true);
    expect(presence.LINEAR_API_KEY).toBe(true);
    expect(presence.CURSOR_API_KEY).toBe(false);
    expect(JSON.stringify(presence)).not.toContain("super-secret-linear");
  });

  it("builds a setup summary without writing local files", async () => {
    const summary = await getSetupStateSummary({ cwd: tempRoot });
    const serialized = JSON.stringify(summary);

    expect(summary.localFiles.some((file) => file.label === ".env.local")).toBe(
      true,
    );
    expect(summary.overview.configResolved).toBe(true);
    expect(summary.overview.operatorConfigResolved).toBe(false);
    expect(summary.missingSteps.length).toBeGreaterThan(0);
    expect(summary.generatedPreviews.envLocal).toContain("HARNESS_CONFIG_PATH=");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toMatch(/LINEAR_API_KEY=[A-Za-z0-9_-]{8,}/);
  });

  it("collects local doctor checks without creating runs/", async () => {
    const checks = await collectLocalDoctorChecks({
      cwd: tempRoot,
      config: JSON.parse(CONFIG_EXAMPLE),
      envLocalExists: false,
      configLocalExists: false,
    });

    expect(checks.some((check) => check.label === ".env.local present")).toBe(
      true,
    );
    expect(
      checks.some(
        (check) =>
          check.skipped &&
          check.label === "LINEAR_API_KEY set",
      ),
    ).toBe(true);
    await expect(
      import("node:fs/promises").then((fs) =>
        fs.access(path.join(tempRoot, "runs")),
      ),
    ).rejects.toThrow();
  });

  it("uses HARNESS_CONFIG_PATH from .env.local over committed harness.config.json", async () => {
    await writeFile(
      path.join(tempRoot, "harness.config.json"),
      buildConfigExample("committed-target"),
      "utf8",
    );
    await writeFile(
      path.join(tempRoot, ".env.local"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\n",
      "utf8",
    );
    await writeFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      buildConfigExample("private-target"),
      "utf8",
    );

    const summary = await getSetupStateSummary({ cwd: tempRoot });

    expect(summary.configSource.kind).toBe("HARNESS_CONFIG_PATH");
    expect(summary.configSource.label).toContain("config.local.json");
    expect(summary.overview.operatorConfigResolved).toBe(true);
    expect(summary.configSummary?.repos[0]?.id).toBe("private-target");
    expect(summary.configSummary?.repos[0]?.id).not.toBe("committed-target");
  });

  it("surfaces a safe parse error without leaking raw file contents or secrets", async () => {
    const secret = "LOCAL_CONFIG_FILE_SECRET_VALUE_99";
    await writeFile(
      path.join(tempRoot, ".env.local"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\n",
      "utf8",
    );
    await writeFile(
      path.join(tempRoot, ".harness", "config.local.json"),
      `{"version":1,"secret":"${secret}","repos":[]}`,
      "utf8",
    );

    const summary = await getSetupStateSummary({ cwd: tempRoot });
    const serialized = JSON.stringify(summary);

    expect(summary.configSource.resolved).toBe(false);
    expect(summary.configSource.parseError).toBeTruthy();
    expect(summary.configSource.parseError).not.toContain(secret);
    expect(serialized).not.toContain(secret);
  });
});

describe("gui-view-model inline config sources", () => {
  let tempRoot = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    savedEnv.HARNESS_CONFIG_JSON = process.env.HARNESS_CONFIG_JSON;
    savedEnv.HARNESS_CONFIG_JSON_B64 = process.env.HARNESS_CONFIG_JSON_B64;
    savedEnv.HARNESS_CONFIG_PATH = process.env.HARNESS_CONFIG_PATH;
    delete process.env.HARNESS_CONFIG_JSON;
    delete process.env.HARNESS_CONFIG_JSON_B64;
    delete process.env.HARNESS_CONFIG_PATH;

    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-gui-inline-"));
    await writeFile(
      path.join(tempRoot, "harness.config.json"),
      buildConfigExample("committed-target"),
      "utf8",
    );
    await writeFile(
      path.join(tempRoot, ".env.example"),
      "HARNESS_CONFIG_PATH=.harness/config.local.json\nLINEAR_API_KEY=\n",
      "utf8",
    );
    const harnessDir = path.join(tempRoot, ".harness");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      path.join(harnessDir, "config.example.json"),
      buildConfigExample("committed-target"),
      "utf8",
    );
  });

  afterEach(async () => {
    if (savedEnv.HARNESS_CONFIG_JSON === undefined) {
      delete process.env.HARNESS_CONFIG_JSON;
    } else {
      process.env.HARNESS_CONFIG_JSON = savedEnv.HARNESS_CONFIG_JSON;
    }
    if (savedEnv.HARNESS_CONFIG_JSON_B64 === undefined) {
      delete process.env.HARNESS_CONFIG_JSON_B64;
    } else {
      process.env.HARNESS_CONFIG_JSON_B64 = savedEnv.HARNESS_CONFIG_JSON_B64;
    }
    if (savedEnv.HARNESS_CONFIG_PATH === undefined) {
      delete process.env.HARNESS_CONFIG_PATH;
    } else {
      process.env.HARNESS_CONFIG_PATH = savedEnv.HARNESS_CONFIG_PATH;
    }

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("resolves HARNESS_CONFIG_JSON without exposing the raw JSON string", async () => {
    const rawJson = JSON.stringify(JSON.parse(buildConfigExample("inline-json-target")));
    process.env.HARNESS_CONFIG_JSON = rawJson;

    const summary = await getSetupStateSummary({ cwd: tempRoot });
    const serialized = JSON.stringify(summary);

    expect(summary.configSource.kind).toBe("HARNESS_CONFIG_JSON");
    expect(summary.configSource.label).toBe("HARNESS_CONFIG_JSON");
    expect(summary.configSummary?.repos[0]?.id).toBe("inline-json-target");
    expect(serialized).not.toContain(rawJson);
  });

  it("resolves HARNESS_CONFIG_JSON_B64 without exposing raw or decoded payloads", async () => {
    const rawJson = JSON.stringify(JSON.parse(buildConfigExample("inline-b64-target")));
    const rawB64 = Buffer.from(rawJson, "utf8").toString("base64");
    process.env.HARNESS_CONFIG_JSON_B64 = rawB64;

    const summary = await getSetupStateSummary({ cwd: tempRoot });
    const serialized = JSON.stringify(summary);

    expect(summary.configSource.kind).toBe("HARNESS_CONFIG_JSON_B64");
    expect(summary.configSource.label).toBe("HARNESS_CONFIG_JSON_B64");
    expect(summary.configSummary?.repos[0]?.id).toBe("inline-b64-target");
    expect(serialized).not.toContain(rawB64);
    expect(serialized).not.toContain(rawJson);
  });
});
