import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config/types.js";
import { computeIssueValidation } from "../../src/validate/issue.js";

const testConfig: HarnessConfig = {
  version: 1,
  orchestratorMarker: "harness-orchestrator-v1",
  logDirectory: "runs",
  repos: [
    {
      id: "target-app",
      linearProjects: ["Example Target App"],
      targetRepo: "https://github.com/owner/example-target-app",
      baseBranch: "dev",
      previewProvider: "none",
    },
  ],
  allowedTargetRepos: ["https://github.com/owner/example-target-app"],
};

const narrowIssueDescription = `## Target repo

owner/example-target-app

## Task

Add a hello page.

## Acceptance criteria

- A page exists

## Out of scope

- Merging`;

const foundationIssueDescription = `## Target repo

owner/example-target-app

## Task

Establish product foundation.

## Product foundation

- Platform runtime: Node.js
- Language framework: TypeScript

## Acceptance criteria

- Marker updated

## Out of scope

- Feature work`;

describe("computeIssueValidation uninitialized product policy", () => {
  it("blocks direct implementation for uninitialized products", () => {
    const result = computeIssueValidation(
      narrowIssueDescription,
      { projectName: "Example Target App" },
      testConfig,
      {
        intendedPhase: "implementation",
        planningMarkerMode: "file",
        productInitializationState: "uninitialized",
      },
    );

    expect(result.validForPlanning).toBe(true);
    expect(result.validForDirectImplementation).toBe(false);
    expect(result.blocksDirectImplementationForUninitializedProduct).toBe(true);
    expect(result.passesIntendedPhase).toBe(false);
  });

  it("allows direct implementation for initialized products when narrow", () => {
    const result = computeIssueValidation(
      narrowIssueDescription,
      { projectName: "Example Target App" },
      testConfig,
      {
        intendedPhase: "implementation",
        planningMarkerMode: "file",
        productInitializationState: "initialized",
      },
    );

    expect(result.validForDirectImplementation).toBe(true);
    expect(result.blocksDirectImplementationForUninitializedProduct).toBe(false);
  });

  it("parses product foundation fields from issue descriptions", () => {
    const result = computeIssueValidation(
      foundationIssueDescription,
      { projectName: "Example Target App" },
      testConfig,
      {
        intendedPhase: "planning",
        planningMarkerMode: "file",
        productInitializationState: "uninitialized",
      },
    );

    expect(result.validForPlanning).toBe(true);
    expect(result.blocksDirectImplementationForUninitializedProduct).toBe(true);
  });
});
