import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyTargetWorkflowAgainstContract,
  hasInvalidHtmlContractMarker,
  parseTargetWorkflowContract,
  TARGET_WORKFLOW_CONTRACT_VERSION,
} from "../../src/setup/target-workflow-contract.js";
import { generateTargetWorkflowYaml } from "../../src/setup/target-workflow-setup.js";

const fixturesDir = path.join(
  process.cwd(),
  "tests/fixtures/workflows",
);

describe("target-workflow-contract v3", () => {
  it("parses YAML # contract markers from the canonical fixture", () => {
    const content = readFileSync(
      path.join(fixturesDir, "trigger-harness-production-sync.yml"),
      "utf8",
    );
    const contract = parseTargetWorkflowContract(content);
    expect(contract).toEqual({
      contractVersion: 3,
      harnessDispatchRepo: "weston-uribe/p-dev-harness-runner",
      repoConfigId: "target-app",
      productionBranch: "main",
    });
    expect(TARGET_WORKFLOW_CONTRACT_VERSION).toBe(3);
    expect(hasInvalidHtmlContractMarker(content)).toBe(false);
  });

  it("still parses HTML v2 markers for upgrade detection", () => {
    const content = readFileSync(
      path.join(fixturesDir, "trigger-harness-production-sync-invalid-html-v2.yml"),
      "utf8",
    );
    expect(hasInvalidHtmlContractMarker(content)).toBe(true);
    const contract = parseTargetWorkflowContract(content);
    expect(contract?.contractVersion).toBe(2);
    expect(contract?.harnessDispatchRepo).toBe(
      "weston-uribe/p-dev-harness-runner",
    );

    const intended = generateTargetWorkflowYaml({
      harnessDispatchRepo: "weston-uribe/p-dev-harness-runner",
      repoConfigId: "weston-uribe-portfolio",
      targetRepoSlug: "weston-uribe/weston-uribe-portfolio",
      productionBranch: "main",
    });
    expect(
      classifyTargetWorkflowAgainstContract({
        existingContent: content,
        intendedContent: intended,
        intendedDispatchRepo: "weston-uribe/p-dev-harness-runner",
      }),
    ).toBe("contract_outdated");
  });
});
