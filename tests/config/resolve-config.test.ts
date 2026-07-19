import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHarnessConfig } from "../../src/config/load-config.js";
import {
  readConfigRaw,
  resolveConfigSource,
} from "../../src/config/resolve-config.js";
import minimalFixture from "../fixtures/config/minimal.json";

const originalArgv = [...process.argv];

function restoreEnv(keys: string[]): void {
  for (const key of keys) {
    delete process.env[key];
  }
}

describe("resolveConfigSource", () => {
  const envKeys = [
    "HARNESS_CONFIG_JSON_B64",
    "HARNESS_CONFIG_JSON",
    "HARNESS_CONFIG_PATH",
  ];

  afterEach(() => {
    process.argv = [...originalArgv];
    restoreEnv(envKeys);
  });

  it("prefers explicit CLI --config <path> over env vars", () => {
    process.argv = ["node", "harness", "doctor", "--config", "/tmp/cli.json"];
    process.env.HARNESS_CONFIG_JSON_B64 = Buffer.from("{}").toString("base64");
    process.env.HARNESS_CONFIG_JSON = "{}";
    process.env.HARNESS_CONFIG_PATH = "/tmp/env.json";

    const source = resolveConfigSource();
    expect(source.kind).toBe("cli-config");
    expect(source.label).toBe(path.resolve("/tmp/cli.json"));
  });

  it("prefers explicit CLI --config=<path> over env vars", () => {
    process.argv = ["node", "harness", "doctor", "--config=/tmp/cli.json"];
    process.env.HARNESS_CONFIG_JSON_B64 = Buffer.from("{}").toString("base64");
    process.env.HARNESS_CONFIG_JSON = "{}";
    process.env.HARNESS_CONFIG_PATH = "/tmp/env.json";

    const source = resolveConfigSource();
    expect(source.kind).toBe("cli-config");
    expect(source.label).toBe(path.resolve("/tmp/cli.json"));
  });

  it("throws when --config has no path argument", () => {
    process.argv = ["node", "harness", "doctor", "--config"];
    process.env.HARNESS_CONFIG_JSON_B64 = Buffer.from("{}").toString("base64");

    expect(() => resolveConfigSource()).toThrow(/--config requires a path/i);
  });

  it("throws when --config= has an empty value", () => {
    process.argv = ["node", "harness", "doctor", "--config="];
    process.env.HARNESS_CONFIG_JSON_B64 = Buffer.from("{}").toString("base64");

    expect(() => resolveConfigSource()).toThrow(/--config requires a path/i);
  });

  it("uses HARNESS_CONFIG_JSON_B64 when argv has no --config", () => {
    process.argv = ["node", "harness", "doctor"];
    const json = JSON.stringify(minimalFixture);
    process.env.HARNESS_CONFIG_JSON_B64 = Buffer.from(json).toString("base64");

    const source = resolveConfigSource();
    expect(source.kind).toBe("HARNESS_CONFIG_JSON_B64");
    expect(source.raw).toBe(json);
  });

  it("uses HARNESS_CONFIG_JSON when B64 is unset", () => {
    process.argv = ["node", "harness", "doctor"];
    const json = JSON.stringify(minimalFixture);
    process.env.HARNESS_CONFIG_JSON = json;

    const source = resolveConfigSource();
    expect(source.kind).toBe("HARNESS_CONFIG_JSON");
    expect(source.raw).toBe(json);
  });

  it("uses HARNESS_CONFIG_PATH when inline env is unset", () => {
    process.argv = ["node", "harness", "doctor"];
    process.env.HARNESS_CONFIG_PATH = "/tmp/private.json";

    const source = resolveConfigSource();
    expect(source.kind).toBe("HARNESS_CONFIG_PATH");
    expect(source.label).toBe(path.resolve("/tmp/private.json"));
  });

  it("falls back to default harness.config.json", () => {
    process.argv = ["node", "harness", "doctor"];
    const source = resolveConfigSource();
    expect(source.kind).toBe("default-file");
    expect(source.label).toBe(path.resolve("harness.config.json"));
  });

  it("does not treat Commander default configPath as explicit --config", () => {
    process.argv = ["node", "harness", "doctor"];
    const json = JSON.stringify(minimalFixture);
    process.env.HARNESS_CONFIG_JSON_B64 = Buffer.from(json).toString("base64");

    const source = resolveConfigSource({ configPath: "harness.config.json" });
    expect(source.kind).toBe("HARNESS_CONFIG_JSON_B64");
  });

  it("throws on invalid base64", () => {
    process.argv = ["node", "harness", "doctor"];
    process.env.HARNESS_CONFIG_JSON_B64 = "not!!!base64";

    expect(() => resolveConfigSource()).toThrow(/not valid base64/i);
  });

  it("treats empty HARNESS_CONFIG_JSON_B64 as unset and falls through", () => {
    process.argv = ["node", "harness", "doctor"];
    process.env.HARNESS_CONFIG_JSON_B64 = "";
    const json = JSON.stringify(minimalFixture);
    process.env.HARNESS_CONFIG_JSON = json;

    const source = resolveConfigSource();
    expect(source.kind).toBe("HARNESS_CONFIG_JSON");
    expect(source.raw).toBe(json);
  });

  it("treats empty HARNESS_CONFIG_JSON as unset and falls through", () => {
    process.argv = ["node", "harness", "doctor"];
    process.env.HARNESS_CONFIG_JSON_B64 = "";
    process.env.HARNESS_CONFIG_JSON = "";
    process.env.HARNESS_CONFIG_PATH = "/tmp/private.json";

    const source = resolveConfigSource();
    expect(source.kind).toBe("HARNESS_CONFIG_PATH");
    expect(source.label).toBe(path.resolve("/tmp/private.json"));
  });

  it("treats empty HARNESS_CONFIG_PATH as unset and falls through to default file", () => {
    process.argv = ["node", "harness", "doctor"];
    process.env.HARNESS_CONFIG_JSON_B64 = "";
    process.env.HARNESS_CONFIG_JSON = "";
    process.env.HARNESS_CONFIG_PATH = "";

    const source = resolveConfigSource();
    expect(source.kind).toBe("default-file");
    expect(source.label).toBe(path.resolve("harness.config.json"));
  });

  it("treats whitespace-only env vars as unset", () => {
    process.argv = ["node", "harness", "doctor"];
    process.env.HARNESS_CONFIG_JSON_B64 = "   ";
    process.env.HARNESS_CONFIG_JSON = "  ";
    process.env.HARNESS_CONFIG_PATH = "\t";

    const source = resolveConfigSource();
    expect(source.kind).toBe("default-file");
  });
});

describe("loadHarnessConfig", () => {
  const envKeys = [
    "HARNESS_CONFIG_JSON_B64",
    "HARNESS_CONFIG_JSON",
    "HARNESS_CONFIG_PATH",
  ];
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "harness-config-"));
    process.argv = ["node", "harness", "doctor"];
  });

  afterEach(async () => {
    process.argv = [...originalArgv];
    restoreEnv(envKeys);
  });

  it("loads valid config from HARNESS_CONFIG_JSON", async () => {
    process.env.HARNESS_CONFIG_JSON = JSON.stringify(minimalFixture);
    const { config, source } = await loadHarnessConfig();
    expect(source.kind).toBe("HARNESS_CONFIG_JSON");
    expect(config.repos[0]?.id).toBe("target-app");
  });

  it("loads valid config from HARNESS_CONFIG_JSON_B64", async () => {
    process.env.HARNESS_CONFIG_JSON_B64 = Buffer.from(
      JSON.stringify(minimalFixture),
    ).toString("base64");
    const { config } = await loadHarnessConfig();
    expect(config.repos[0]?.id).toBe("target-app");
  });

  it("loads from HARNESS_CONFIG_PATH", async () => {
    const filePath = path.join(tempDir, "private.json");
    await writeFile(filePath, JSON.stringify(minimalFixture));
    process.env.HARNESS_CONFIG_PATH = filePath;

    const { config, source } = await loadHarnessConfig();
    expect(source.kind).toBe("HARNESS_CONFIG_PATH");
    expect(config.repos[0]?.id).toBe("target-app");
  });

  it("explicit --config <path> overrides HARNESS_CONFIG_JSON_B64", async () => {
    const filePath = path.join(tempDir, "cli.json");
    await writeFile(filePath, JSON.stringify(minimalFixture));
    process.argv = ["node", "harness", "doctor", "--config", filePath];
    process.env.HARNESS_CONFIG_JSON_B64 = Buffer.from(
      JSON.stringify({ version: 1, bad: true }),
    ).toString("base64");

    const { config, source } = await loadHarnessConfig({
      configPath: "harness.config.json",
    });
    expect(source.kind).toBe("cli-config");
    expect(config.repos[0]?.id).toBe("target-app");
  });

  it("explicit --config=<path> overrides HARNESS_CONFIG_JSON_B64", async () => {
    const filePath = path.join(tempDir, "cli.json");
    await writeFile(filePath, JSON.stringify(minimalFixture));
    process.argv = ["node", "harness", "doctor", `--config=${filePath}`];
    process.env.HARNESS_CONFIG_JSON_B64 = Buffer.from(
      JSON.stringify({ version: 1, bad: true }),
    ).toString("base64");

    const { config, source } = await loadHarnessConfig({
      configPath: "harness.config.json",
    });
    expect(source.kind).toBe("cli-config");
    expect(config.repos[0]?.id).toBe("target-app");
  });

  it("fails closed on invalid inline JSON", async () => {
    process.env.HARNESS_CONFIG_JSON = "{not-json";
    await expect(loadHarnessConfig()).rejects.toThrow(/not valid JSON/i);
  });

  it("fails closed when HARNESS_CONFIG_PATH points at a missing file", async () => {
    process.env.HARNESS_CONFIG_PATH = path.join(tempDir, "does-not-exist.json");
    await expect(loadHarnessConfig()).rejects.toThrow(/Config file not found/i);
  });

  it("falls through empty GHA-style env vars to default committed config", async () => {
    process.env.HARNESS_CONFIG_JSON_B64 = "";
    process.env.HARNESS_CONFIG_JSON = "";
    process.env.HARNESS_CONFIG_PATH = "";

    const { config, source } = await loadHarnessConfig();
    expect(source.kind).toBe("default-file");
    expect(config.repos.some((repo) => repo.id === "target-app")).toBe(true);
  });

  it("fails closed on invalid HARNESS_CONFIG_JSON_B64 without falling through", async () => {
    process.env.HARNESS_CONFIG_JSON_B64 = "not-base64";
    process.env.HARNESS_CONFIG_JSON = JSON.stringify(minimalFixture);

    await expect(loadHarnessConfig()).rejects.toThrow(/not valid base64/i);
  });

  it("readConfigRaw returns inline raw without file read", async () => {
    const source = {
      kind: "HARNESS_CONFIG_JSON" as const,
      label: "HARNESS_CONFIG_JSON",
      raw: JSON.stringify(minimalFixture),
    };
    const raw = await readConfigRaw(source);
    expect(JSON.parse(raw).version).toBe(1);
  });
});
