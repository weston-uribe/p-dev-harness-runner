import { describe, expect, it } from "vitest";
import {
  buildHarnessManagedRepoMarker,
  parseHarnessManagedRepoMarkerJson,
  validateManagedMarkerForReconnect,
} from "../../src/setup/harness-managed-repo-marker.js";

const TEMPLATE_IDENTITY = {
  schemaVersion: 1,
  product: "p-dev",
  role: "harness-template",
  templateIdentity: "p-dev-harness-template",
  templateVersion: 1,
  compatibilityVersion: 1,
  templateContentId: "template-content-v1",
};

function validMarker(overrides: Record<string, unknown> = {}) {
  const marker = buildHarnessManagedRepoMarker({
    repository: "test-user/p-dev-harness",
    repositoryId: 100_001,
    templateIdentity: TEMPLATE_IDENTITY,
    defaultBranch: "main",
    sourceHeadSha: "abc123templatehead",
    operationId: "op-1",
    createdByGithubUserId: 1,
    createdByLogin: "test-user",
    pDevVersion: "0.3.0",
  });
  return { ...marker, ...overrides };
}

describe("harness managed repo marker", () => {
  it("rejects missing templateRepository", () => {
    const marker = validMarker();
    const broken = {
      ...marker,
      createdFromTemplate: {
        ...marker.createdFromTemplate,
        templateRepository: "",
      },
    };
    const parsed = parseHarnessManagedRepoMarkerJson(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
  });

  it("rejects wrong templateRepository", () => {
    const marker = validMarker();
    const broken = {
      ...marker,
      createdFromTemplate: {
        ...marker.createdFromTemplate,
        templateRepository: "other/template",
      },
    };
    const parsed = parseHarnessManagedRepoMarkerJson(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
  });

  it("rejects missing defaultBranch", () => {
    const marker = validMarker();
    const broken = {
      ...marker,
      createdFromTemplate: {
        ...marker.createdFromTemplate,
        defaultBranch: "",
      },
    };
    const parsed = parseHarnessManagedRepoMarkerJson(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
  });

  it("rejects missing templateVersion", () => {
    const marker = validMarker();
    const broken = {
      ...marker,
      createdFromTemplate: {
        ...marker.createdFromTemplate,
        templateVersion: undefined,
      },
    };
    const parsed = parseHarnessManagedRepoMarkerJson(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
  });

  it("rejects wrong compatibility version", () => {
    const marker = validMarker();
    const broken = {
      ...marker,
      createdFromTemplate: {
        ...marker.createdFromTemplate,
        compatibilityVersion: 2,
      },
    };
    const parsed = parseHarnessManagedRepoMarkerJson(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
  });

  it("rejects malformed template identity", () => {
    const marker = validMarker();
    const broken = {
      ...marker,
      createdFromTemplate: {
        ...marker.createdFromTemplate,
        templateIdentity: "not-a-valid-identity",
      },
    };
    const parsed = parseHarnessManagedRepoMarkerJson(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
  });

  it("rejects marker repository mismatch on reconnect validation", () => {
    const marker = validMarker();
    const parsed = parseHarnessManagedRepoMarkerJson(JSON.stringify(marker));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const reconnect = validateManagedMarkerForReconnect(
      parsed.marker,
      "other-user/p-dev-harness",
      { repositoryId: parsed.marker.repositoryId! },
    );
    expect(reconnect.ok).toBe(false);
  });

  it("rejects parseable marker from a different repo slug", () => {
    const marker = validMarker({ repository: "other-user/p-dev-harness" });
    const parsed = parseHarnessManagedRepoMarkerJson(JSON.stringify(marker));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const reconnect = validateManagedMarkerForReconnect(
      parsed.marker,
      "test-user/p-dev-harness",
      { repositoryId: parsed.marker.repositoryId! },
    );
    expect(reconnect.ok).toBe(false);
  });
});
