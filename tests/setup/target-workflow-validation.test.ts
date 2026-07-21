import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseTargetWorkflowYamlDocument,
  validateGeneratedTargetWorkflow,
} from "../../src/setup/target-workflow-validation.js";
import { generateTargetWorkflowYaml } from "../../src/setup/target-workflow-setup.js";

const fixturesDir = path.join(process.cwd(), "tests/fixtures/workflows");

describe("target-workflow-validation", () => {
  it("parses YAML 1.2 so top-level on remains a string key", () => {
    const content = generateTargetWorkflowYaml({
      harnessDispatchRepo: "weston-uribe/p-dev-harness-runner",
      repoConfigId: "target-app",
      targetRepoSlug: "owner/example-target-app",
      productionBranch: "main",
    });
    const parsed = parseTargetWorkflowYamlDocument(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.keys).toContain("on");
    expect(parsed.keys).not.toContain("true");
    expect(parsed.data.on).toBeTypeOf("object");
  });

  it("accepts generated contract-v3 workflows", () => {
    const content = generateTargetWorkflowYaml({
      harnessDispatchRepo: "weston-uribe/p-dev-harness-runner",
      repoConfigId: "target-app",
      targetRepoSlug: "owner/example-target-app",
      productionBranch: "main",
    });
    const result = validateGeneratedTargetWorkflow({
      content,
      expectedProductionBranch: "main",
      expectedDispatchRepo: "weston-uribe/p-dev-harness-runner",
      expectedRepoConfigId: "target-app",
      expectedTargetRepoSlug: "owner/example-target-app",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.contractVersion).toBe(3);
  });

  it("rejects HTML-prefixed invalid v2 workflow content", () => {
    const content = readFileSync(
      path.join(
        fixturesDir,
        "trigger-harness-production-sync-invalid-html-v2.yml",
      ),
      "utf8",
    );
    const result = validateGeneratedTargetWorkflow({
      content,
      expectedProductionBranch: "main",
      expectedDispatchRepo: "weston-uribe/p-dev-harness-runner",
      expectedRepoConfigId: "weston-uribe-portfolio",
      expectedTargetRepoSlug: "weston-uribe/weston-uribe-portfolio",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /HTML|YAML #/.test(error))).toBe(true);
  });

  it("rejects archived dispatch targets", () => {
    const content = generateTargetWorkflowYaml({
      harnessDispatchRepo: "weston-uribe/p-dev-harness-runner",
      repoConfigId: "target-app",
      targetRepoSlug: "owner/example-target-app",
      productionBranch: "main",
    }).replaceAll(
      "weston-uribe/p-dev-harness-runner",
      "weston-uribe/p-dev-harness",
    );
    const result = validateGeneratedTargetWorkflow({
      content,
      expectedProductionBranch: "main",
      expectedDispatchRepo: "weston-uribe/p-dev-harness",
      expectedRepoConfigId: "target-app",
      expectedTargetRepoSlug: "owner/example-target-app",
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((error) => /archived harness repository/.test(error)),
    ).toBe(true);
  });
});
