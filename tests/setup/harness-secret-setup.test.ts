import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHarnessSecretWritePlan,
  generateHarnessConfigJsonB64,
  previewHarnessSecretSetup,
  readValidatedConfigLocalBytes,
  resolveHarnessSecretOperatorInput,
} from "../../src/setup/harness-secret-setup.js";

const FAKE_SECRETS = {
  linearApiKey: "fake-linear-secret-value",
  cursorApiKey: "fake-cursor-secret-value",
  githubToken: "fake-github-secret-value",
};

describe("harness-secret-setup", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-secret-setup-"));
    const harnessDir = path.join(tempRoot, ".harness");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      path.join(harnessDir, "config.local.json"),
      JSON.stringify(
        {
          version: 1,
          repos: [
            {
              id: "target-app",
              targetRepo: "https://github.com/owner/example-target-app",
            },
          ],
          allowedTargetRepos: ["https://github.com/owner/example-target-app"],
        },
        null,
        2,
      ),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("generates HARNESS_CONFIG_JSON_B64 from validated config bytes", async () => {
    const { bytes } = await readValidatedConfigLocalBytes(tempRoot);
    const encoded = generateHarnessConfigJsonB64(bytes);
    expect(encoded.length).toBeGreaterThan(0);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toContain(
      "target-app",
    );
  });

  it("builds secret write plan with key names only in preview summary", async () => {
    const plan = buildHarnessSecretWritePlan({
      operatorInput: FAKE_SECRETS,
      configLocalExists: true,
      secretStatuses: [
        { name: "LINEAR_API_KEY", status: "missing" },
        { name: "CURSOR_API_KEY", status: "missing" },
        { name: "HARNESS_GITHUB_TOKEN", status: "missing" },
        { name: "HARNESS_CONFIG_JSON_B64", status: "missing" },
      ],
    });

    const preview = await previewHarnessSecretSetup({
      cwd: tempRoot,
      operatorInput: FAKE_SECRETS,
      manualHarnessDispatchRepo: "owner/harness-repo",
    });
    const serialized = JSON.stringify({ plan, preview });

    expect(plan.some((entry) => entry.name === "HARNESS_CONFIG_JSON_B64")).toBe(
      true,
    );
    expect(preview.previewSummary).toContain("HARNESS_CONFIG_JSON_B64");
    expect(preview.previewSummary).not.toContain(FAKE_SECRETS.linearApiKey);
    expect(serialized).not.toContain(FAKE_SECRETS.linearApiKey);
    expect(serialized).not.toContain(FAKE_SECRETS.cursorApiKey);
    expect(serialized).not.toContain(FAKE_SECRETS.githubToken);
  });

  it("preserves existing credential secrets unless explicit replacement is requested", () => {
    const plan = buildHarnessSecretWritePlan({
      operatorInput: FAKE_SECRETS,
      configLocalExists: true,
      secretStatuses: [
        { name: "LINEAR_API_KEY", status: "present" },
        { name: "CURSOR_API_KEY", status: "present" },
        { name: "HARNESS_GITHUB_TOKEN", status: "present" },
        { name: "HARNESS_CONFIG_JSON_B64", status: "present" },
      ],
    });

    expect(plan).toEqual([
      {
        name: "HARNESS_CONFIG_JSON_B64",
        action: "update",
        source: "generated-config-b64",
      },
      {
        name: "LINEAR_API_KEY",
        action: "skip",
        source: "preserve-existing",
      },
      {
        name: "CURSOR_API_KEY",
        action: "skip",
        source: "preserve-existing",
      },
      {
        name: "HARNESS_GITHUB_TOKEN",
        action: "skip",
        source: "preserve-existing",
      },
    ]);
  });

  it("updates existing credential secrets only with explicit replacement intent", () => {
    const plan = buildHarnessSecretWritePlan({
      operatorInput: {
        ...FAKE_SECRETS,
        explicitCredentialReplacements: ["LINEAR_API_KEY"],
      },
      configLocalExists: true,
      secretStatuses: [
        { name: "LINEAR_API_KEY", status: "present" },
        { name: "CURSOR_API_KEY", status: "present" },
        { name: "HARNESS_GITHUB_TOKEN", status: "present" },
        { name: "HARNESS_CONFIG_JSON_B64", status: "present" },
      ],
    });

    expect(plan.find((entry) => entry.name === "LINEAR_API_KEY")).toEqual({
      name: "LINEAR_API_KEY",
      action: "update",
      source: "operator-input",
    });
    expect(plan.find((entry) => entry.name === "CURSOR_API_KEY")).toEqual({
      name: "CURSOR_API_KEY",
      action: "skip",
      source: "preserve-existing",
    });
  });

  it("creates missing credential secrets from operator input", () => {
    const plan = buildHarnessSecretWritePlan({
      operatorInput: FAKE_SECRETS,
      configLocalExists: true,
      secretStatuses: [
        { name: "LINEAR_API_KEY", status: "missing" },
        { name: "CURSOR_API_KEY", status: "missing" },
        { name: "HARNESS_GITHUB_TOKEN", status: "missing" },
        { name: "HARNESS_CONFIG_JSON_B64", status: "missing" },
      ],
    });

    expect(plan.filter((entry) => entry.action === "create").map((entry) => entry.name)).toEqual(
      [
        "HARNESS_CONFIG_JSON_B64",
        "LINEAR_API_KEY",
        "CURSOR_API_KEY",
        "HARNESS_GITHUB_TOKEN",
      ],
    );
  });

  it("loads saved local credential values for automatic setup enrichment", async () => {
    await writeFile(
      path.join(tempRoot, ".env.local"),
      [
        "LINEAR_API_KEY=lin_saved",
        "CURSOR_API_KEY=cur_saved",
        "GITHUB_TOKEN=ghp_saved",
      ].join("\n"),
      "utf8",
    );

    const operatorInput = await resolveHarnessSecretOperatorInput({
      cwd: tempRoot,
      payload: {},
    });

    expect(operatorInput.linearApiKey).toBe("lin_saved");
    expect(operatorInput.cursorApiKey).toBe("cur_saved");
    expect(operatorInput.githubToken).toBe("ghp_saved");
    expect(operatorInput.explicitCredentialReplacements).toBeUndefined();
    expect(operatorInput.credentialInputSources).toEqual({
      linearApiKey: "enriched-local",
      cursorApiKey: "enriched-local",
      harnessGithubToken: "enriched-local",
      vercelToken: "absent",
    });
  });

  it("changes harness secret fingerprint when enriched local credentials change", async () => {
    await writeFile(
      path.join(tempRoot, ".env.local"),
      "LINEAR_API_KEY=lin_saved\n",
      "utf8",
    );

    const operatorInput = await resolveHarnessSecretOperatorInput({
      cwd: tempRoot,
      payload: {},
    });
    const first = await previewHarnessSecretSetup({
      cwd: tempRoot,
      operatorInput,
      manualHarnessDispatchRepo: "owner/harness-repo",
    });

    await writeFile(
      path.join(tempRoot, ".env.local"),
      "LINEAR_API_KEY=lin_saved_rotated\n",
      "utf8",
    );
    const rotatedInput = await resolveHarnessSecretOperatorInput({
      cwd: tempRoot,
      payload: {},
    });
    const second = await previewHarnessSecretSetup({
      cwd: tempRoot,
      operatorInput: rotatedInput,
      manualHarnessDispatchRepo: "owner/harness-repo",
    });

    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(JSON.stringify(first)).not.toContain("lin_saved");
    expect(JSON.stringify(second)).not.toContain("lin_saved_rotated");
  });

  it("marks payload credentials separately from enriched-local sources", async () => {
    await writeFile(
      path.join(tempRoot, ".env.local"),
      "LINEAR_API_KEY=lin_saved\n",
      "utf8",
    );

    const operatorInput = await resolveHarnessSecretOperatorInput({
      cwd: tempRoot,
      payload: { linearApiKey: "lin_payload" },
    });

    expect(operatorInput.credentialInputSources?.linearApiKey).toBe("payload");
    expect(operatorInput.credentialInputSources?.cursorApiKey).toBe("absent");
    expect(operatorInput.explicitCredentialReplacements).toEqual([
      "LINEAR_API_KEY",
    ]);
  });
});
