import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergeEnvFileContent,
  mergeEnvInput,
  parseEnvFileContent,
  readExistingEnvFile,
  redactEnvContent,
} from "../../src/setup/env-merge.js";
import { resolveLocalFilePaths } from "../../src/setup/setup-state.js";

const EXISTING_LINEAR = "existing-linear-secret-abc";
const NEW_CURSOR = "new-cursor-secret-xyz";
const NEW_LINEAR = "replacement-linear-secret";

describe("env-merge", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-env-merge-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("preserves existing secret when submitted field is blank", () => {
    const existing = parseEnvFileContent(
      `HARNESS_CONFIG_PATH=.harness/config.local.json\nLINEAR_API_KEY=${EXISTING_LINEAR}\n`,
    );

    const merged = mergeEnvInput(existing, {
      harnessConfigPath: ".harness/config.local.json",
    });

    expect(merged.linearApiKey).toBe(EXISTING_LINEAR);
    expect(merged.cursorApiKey).toBeUndefined();
  });

  it("replaces existing secret when submitted field is non-blank", () => {
    const existing = parseEnvFileContent(
      `LINEAR_API_KEY=${EXISTING_LINEAR}\n`,
    );

    const merged = mergeEnvInput(existing, {
      linearApiKey: NEW_LINEAR,
      cursorApiKey: NEW_CURSOR,
    });

    expect(merged.linearApiKey).toBe(NEW_LINEAR);
    expect(merged.cursorApiKey).toBe(NEW_CURSOR);
  });

  it("merges VERCEL_TOKEN into managed env output", () => {
    const merged = mergeEnvInput(undefined, {
      vercelToken: "vercel-token-abc",
    });
    const output = mergeEnvFileContent("", merged);

    expect(output).toContain("VERCEL_TOKEN=vercel-token-abc");
  });

  it("preserves unrelated env keys after merge", () => {
    const existingContent = [
      "# local notes",
      "",
      "MY_CUSTOM_TOOL=keep-me",
      `LINEAR_API_KEY=${EXISTING_LINEAR}`,
    ].join("\n");

    const merged = mergeEnvInput(parseEnvFileContent(existingContent), {
      cursorApiKey: NEW_CURSOR,
    });
    const output = mergeEnvFileContent(existingContent, merged);

    expect(output).toContain("# local notes");
    expect(output).toContain("MY_CUSTOM_TOOL=keep-me");
    expect(output).toContain(`CURSOR_API_KEY=${NEW_CURSOR}`);
    expect(output).toContain(`LINEAR_API_KEY=${EXISTING_LINEAR}`);
  });

  it("preserves comments and blank lines after merge", () => {
    const existingContent = [
      "# top comment",
      "",
      "# middle comment",
      `LINEAR_API_KEY=${EXISTING_LINEAR}`,
      "",
      "# tail comment",
    ].join("\n");

    const merged = mergeEnvInput(parseEnvFileContent(existingContent), {
      harnessConfigPath: ".harness/config.local.json",
    });
    const output = mergeEnvFileContent(existingContent, merged);

    expect(output).toContain("# top comment");
    expect(output).toContain("# middle comment");
    expect(output).toContain("# tail comment");
    expect(output.split("\n")).toContain("");
  });

  it("appends missing managed keys in harness-managed section", () => {
    const existingContent = "MY_CUSTOM_TOOL=keep-me\n";
    const merged = mergeEnvInput(null, {
      harnessConfigPath: ".harness/config.local.json",
      linearApiKey: EXISTING_LINEAR,
    });
    const output = mergeEnvFileContent(existingContent, merged);

    expect(output).toContain("MY_CUSTOM_TOOL=keep-me");
    expect(output).toContain("# --- Harness managed keys ---");
    expect(output).toContain("HARNESS_CONFIG_PATH=.harness/config.local.json");
    expect(output).toContain(`LINEAR_API_KEY=${EXISTING_LINEAR}`);
  });

  it("redacts preview content without exposing raw secret values", () => {
    const content = mergeEnvFileContent(null, {
      harnessConfigPath: ".harness/config.local.json",
      linearApiKey: EXISTING_LINEAR,
      cursorApiKey: NEW_CURSOR,
      githubToken: "github-token-secret",
    });

    const redacted = redactEnvContent(content);

    expect(redacted).toContain("LINEAR_API_KEY=<redacted>");
    expect(redacted).not.toContain(EXISTING_LINEAR);
    expect(redacted).not.toContain(NEW_CURSOR);
    expect(redacted).not.toContain("github-token-secret");
  });

  it("redacts managed secrets but preserves unmanaged lines in preview", () => {
    const existingContent = [
      "# keep",
      "MY_CUSTOM_TOOL=visible-value",
      `LINEAR_API_KEY=${EXISTING_LINEAR}`,
    ].join("\n");
    const merged = mergeEnvInput(parseEnvFileContent(existingContent), {});
    const redacted = redactEnvContent(
      mergeEnvFileContent(existingContent, merged),
    );

    expect(redacted).toContain("# keep");
    expect(redacted).toContain("MY_CUSTOM_TOOL=visible-value");
    expect(redacted).toContain("LINEAR_API_KEY=<redacted>");
    expect(redacted).not.toContain(EXISTING_LINEAR);
  });

  it("creates valid generated content when no existing file", () => {
    const merged = mergeEnvInput(null, {
      harnessConfigPath: ".harness/config.local.json",
      linearApiKey: EXISTING_LINEAR,
    });
    const content = mergeEnvFileContent(null, merged);

    expect(content).toContain("HARNESS_CONFIG_PATH=.harness/config.local.json");
    expect(content).toContain(`LINEAR_API_KEY=${EXISTING_LINEAR}`);
  });

  it("reads existing env file without exposing values in API helpers", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    await writeFile(
      paths.envLocal,
      `LINEAR_API_KEY=${EXISTING_LINEAR}\n`,
      "utf8",
    );

    const parsed = await readExistingEnvFile(paths);

    expect(parsed?.presence.LINEAR_API_KEY).toBe(true);
    expect(parsed?.values.LINEAR_API_KEY).toBe(EXISTING_LINEAR);
    expect(JSON.stringify(parsed?.presence)).not.toContain(EXISTING_LINEAR);
  });
});
