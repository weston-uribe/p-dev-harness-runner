import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistGeneratedLinearWebhookSecret,
  readLinearWebhookSecretFromEnvLocal,
  upsertLinearWebhookSecretInEnvContent,
} from "../../src/setup/linear-webhook-env-local.js";
import { parseEnvFileContent } from "../../src/setup/env-merge.js";
import { resolveLocalFilePaths } from "../../src/setup/setup-state.js";

const GENERATED_SECRET = "a".repeat(64);
const EXISTING_OPERATOR_SECRET = "operator-webhook-secret-value";
const EXISTING_LINEAR_API_KEY = "lin_api_existing";

describe("linear-webhook-env-local", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "linear-webhook-env-local-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("writes generated LINEAR_WEBHOOK_SECRET to a new .env.local file", async () => {
    const wrote = await persistGeneratedLinearWebhookSecret({
      cwd: tempRoot,
      secret: GENERATED_SECRET,
    });

    expect(wrote).toBe(true);
    const content = await readFile(
      resolveLocalFilePaths(tempRoot).envLocal,
      "utf8",
    );
    expect(content).toContain(`LINEAR_WEBHOOK_SECRET=${GENERATED_SECRET}`);
  });

  it("preserves existing tokens and config when upserting webhook secret", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    await writeFile(
      paths.envLocal,
      [
        "# local notes",
        "MY_CUSTOM_TOOL=keep-me",
        `LINEAR_API_KEY=${EXISTING_LINEAR_API_KEY}`,
      ].join("\n"),
      "utf8",
    );

    await persistGeneratedLinearWebhookSecret({
      cwd: tempRoot,
      secret: GENERATED_SECRET,
    });

    const content = await readFile(paths.envLocal, "utf8");
    const parsed = parseEnvFileContent(content);
    expect(content).toContain("# local notes");
    expect(content).toContain("MY_CUSTOM_TOOL=keep-me");
    expect(parsed.values.LINEAR_API_KEY).toBe(EXISTING_LINEAR_API_KEY);
    expect(parsed.values.LINEAR_WEBHOOK_SECRET).toBe(GENERATED_SECRET);
  });

  it("does not overwrite an explicit existing LINEAR_WEBHOOK_SECRET by default", async () => {
    const paths = resolveLocalFilePaths(tempRoot);
    await writeFile(
      paths.envLocal,
      `LINEAR_WEBHOOK_SECRET=${EXISTING_OPERATOR_SECRET}\n`,
      "utf8",
    );

    const wrote = await persistGeneratedLinearWebhookSecret({
      cwd: tempRoot,
      secret: GENERATED_SECRET,
    });

    expect(wrote).toBe(false);
    const saved = await readLinearWebhookSecretFromEnvLocal({ cwd: tempRoot });
    expect(saved).toBe(EXISTING_OPERATOR_SECRET);
  });

  it("upsertLinearWebhookSecretInEnvContent replaces an existing key in place", () => {
    const content = upsertLinearWebhookSecretInEnvContent(
      `LINEAR_WEBHOOK_SECRET=old-secret\nLINEAR_API_KEY=keep\n`,
      GENERATED_SECRET,
    );

    expect(content).toContain(`LINEAR_WEBHOOK_SECRET=${GENERATED_SECRET}`);
    expect(content).toContain("LINEAR_API_KEY=keep");
    expect(content).not.toContain("old-secret");
  });
});
