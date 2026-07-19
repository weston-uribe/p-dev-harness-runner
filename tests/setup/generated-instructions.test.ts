import { describe, expect, it } from "vitest";
import {
  generateCloudValidationInstructions,
  generateGitHubSecretInstructions,
  generateHarnessConfigB64Instructions,
  generateTargetRepoWorkflowInstructions,
} from "../../src/setup/generated-instructions.js";

describe("generated-instructions", () => {
  it("includes HARNESS_CONFIG_JSON_B64 encoding guidance", () => {
    const instructions = generateHarnessConfigB64Instructions();

    expect(instructions.command).toContain("base64 < .harness/config.local.json");
    expect(instructions.steps.join("\n")).toContain("HARNESS_CONFIG_JSON_B64");
  });

  it("lists GitHub secret names without printing secret values", () => {
    const instructions = generateGitHubSecretInstructions({
      harnessRepo: "owner/agentic-product-development-harness",
    });

    const joined = instructions.steps.join("\n");
    expect(joined).toContain("HARNESS_CONFIG_JSON_B64");
    expect(joined).toContain("LINEAR_API_KEY");
    expect(joined).toContain("CURSOR_API_KEY");
    expect(joined).toContain("HARNESS_GITHUB_TOKEN");
    expect(joined).not.toMatch(/LINEAR_API_KEY=[^ ]+/);
  });

  it("uses manual placeholder when harness repo is unresolved", () => {
    const instructions = generateGitHubSecretInstructions();
    expect(instructions.steps.join("\n")).toContain("<harness-dispatch-repo>");
  });

  it("uses generic target repo workflow placeholders", () => {
    const instructions = generateTargetRepoWorkflowInstructions();

    expect(instructions.steps.join("\n")).toContain("target-app");
    expect(instructions.steps.join("\n")).toContain("owner/example-target-app");
  });

  it("documents safe cloud validation sequence", () => {
    const instructions = generateCloudValidationInstructions();

    expect(instructions.steps.join("\n")).toContain("sync_repo=harness");
    expect(instructions.steps.join("\n")).toContain("sync_dry_run=true");
  });
});
