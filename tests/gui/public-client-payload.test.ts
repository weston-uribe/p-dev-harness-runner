import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_PUBLIC_DTO_FIELD_NAMES,
  REVIEWED_PUBLIC_DTO_FIELD_ALLOWLIST,
  SecretBearingClientPayloadError,
  assertNoSecretBearingClientPayload,
  toPublicApiError,
  toPublicWorkflowBootstrap,
} from "../../src/gui/public-client-payload.js";
import type { WorkflowBootstrapPayload } from "../../src/workflow-page/types.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const MINIMAL_BOOTSTRAP: WorkflowBootstrapPayload = {
  sourceMode: "fixture",
  selectedScopeId: "scope-1",
  scopes: [
    {
      id: "scope-1",
      targetRepo: "acme/app",
      linearTeams: ["WES"],
      linearProjects: ["App"],
      baseBranch: "dev",
      productionBranch: "main",
    },
  ],
  statuses: [],
  currentWorkflowMappings: [],
  modelCatalog: [
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      availability: "available",
      supportedParameters: [],
      source: "fixture",
    },
  ],
  catalogLoadMetadata: {
    statusCatalog: "loaded",
    modelCatalog: "loaded",
  },
  plannerSelection: {
    modelId: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [],
    source: "roleModels",
  },
  builderSelection: {
    modelId: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [],
    source: "roleModels",
  },
  planReviewerSelection: {
    modelId: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [],
    source: "roleModels",
  },
  codeReviewerSelection: {
    modelId: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [],
    source: "roleModels",
  },
  codeReviserSelection: {
    modelId: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [],
    source: "roleModels",
  },
  planReviewReadiness: {
    requestedEnabled: false,
    effectiveEnabled: false,
    uiState: "disabled",
    missingRequirementMessages: ["Plan Review is disabled in configuration."],
    cycleLimit: 4,
  },
  codeReviewReadiness: {
    requestedEnabled: false,
    effectiveEnabled: false,
    uiState: "disabled",
    missingRequirementMessages: ["Code Review is disabled in configuration."],
    cycleLimit: 4,
  },
  configFingerprint: "abc",
  modelSaveReadiness: {
    planner: {
      role: "planner",
      ready: true,
      state: "ready",
      issues: [],
    },
    builder: {
      role: "builder",
      ready: true,
      state: "ready",
      issues: [],
    },
    planReviewer: {
      role: "planReviewer",
      ready: true,
      state: "ready",
      issues: [],
    },
    codeReviewer: {
      role: "codeReviewer",
      ready: true,
      state: "ready",
      issues: [],
    },
    codeReviser: {
      role: "codeReviser",
      ready: true,
      state: "ready",
      issues: [],
    },
    ready: true,
  },
  canonicalWorkflow: {
    healthState: "healthy",
    violations: [],
    informationalWarnings: [],
    resolvedStatusIds: {},
    mergePathVariant: "integration-then-production",
  },
  warnings: [],
  dataSourceLabel: "Fixture",
};

describe("public client payload boundary", () => {
  it("builds a fresh allowlisted workflow bootstrap DTO", () => {
    const publicPayload = toPublicWorkflowBootstrap(MINIMAL_BOOTSTRAP);
    expect(publicPayload.plannerSelection.modelId).toBe("composer-2.5");
    expect(publicPayload.scopes[0]?.id).toBe("scope-1");
    expect(publicPayload).not.toBe(MINIMAL_BOOTSTRAP);
    expect(publicPayload.scopes).not.toBe(MINIMAL_BOOTSTRAP.scopes);
  });

  it("rejects payloads containing known secrets or env file content", () => {
    expect(() =>
      assertNoSecretBearingClientPayload(
        { ok: true, note: "SECRET_CANARY_LINEAR_abc" },
        {
          context: "test",
          knownSecrets: ["SECRET_CANARY_LINEAR_abc"],
        },
      ),
    ).toThrow(SecretBearingClientPayloadError);

    expect(() =>
      assertNoSecretBearingClientPayload(
        {
          preview:
            "# Operator local setup\nLINEAR_API_KEY=SECRET_CANARY_LINEAR_abc\n",
        },
        { context: "test" },
      ),
    ).toThrow(/raw \.env\.local|secret environment/);
  });

  it("rejects forbidden public DTO field names", () => {
    expect(() =>
      assertNoSecretBearingClientPayload(
        { token: "x" },
        { context: "test" },
      ),
    ).toThrow(/forbidden field names/);
  });

  it("converts errors into safe public API errors", () => {
    const leaked = toPublicApiError(
      new Error("failed LINEAR_API_KEY=SECRET_CANARY_LINEAR_abc"),
      {
        fallbackMessage: "Request failed.",
        knownSecrets: ["SECRET_CANARY_LINEAR_abc"],
      },
    );
    expect(leaked.message).toBe("Request failed.");
    expect(leaked.message).not.toContain("SECRET_CANARY");
  });

  it("guards WorkflowBootstrapPayload source against forbidden field names", () => {
    const typesSource = readFileSync(
      path.join(repoRoot, "src/workflow-page/types.ts"),
      "utf8",
    );
    const payloadBlock = typesSource.slice(
      typesSource.indexOf("export interface WorkflowBootstrapPayload"),
      typesSource.indexOf("export interface WorkflowBootstrapPayload") + 800,
    );
    for (const forbidden of FORBIDDEN_PUBLIC_DTO_FIELD_NAMES) {
      const pattern = new RegExp(`\\b${forbidden}\\b`, "i");
      if (pattern.test(payloadBlock)) {
        const allowlisted = REVIEWED_PUBLIC_DTO_FIELD_ALLOWLIST.some((entry) =>
          entry.toLowerCase().includes(forbidden.toLowerCase()),
        );
        expect(allowlisted).toBe(true);
      }
    }
  });

  it("documents reviewed allowlist next to the serializer", () => {
    const source = readFileSync(
      path.join(repoRoot, "src/gui/public-client-payload.ts"),
      "utf8",
    );
    expect(source).toContain("REVIEWED_PUBLIC_DTO_FIELD_ALLOWLIST");
    expect(source).toContain("FORBIDDEN_PUBLIC_DTO_FIELD_NAMES");
  });
});
