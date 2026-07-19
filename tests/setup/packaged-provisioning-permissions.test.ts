import { describe, expect, it } from "vitest";
import {
  assessPackagedProvisioningTokenCapabilities,
  classicPatHasPrivateRepoScope,
} from "../../src/setup/github-workflow-permissions.js";

describe("packaged provisioning token capabilities", () => {
  it("requires classic PAT with repo and workflow scopes", () => {
    const result = assessPackagedProvisioningTokenCapabilities({
      login: "test-user",
      tokenType: "classic",
      oauthScopes: ["repo", "workflow"],
      hasRepoScope: true,
      hasWorkflowScope: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects public_repo-only classic PAT for private workspace creation", () => {
    expect(classicPatHasPrivateRepoScope(["public_repo"])).toBe(false);
    const result = assessPackagedProvisioningTokenCapabilities({
      login: "test-user",
      tokenType: "classic",
      oauthScopes: ["public_repo", "workflow"],
      hasRepoScope: true,
      hasWorkflowScope: true,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects fine-grained PAT for packaged provisioning", () => {
    const result = assessPackagedProvisioningTokenCapabilities({
      login: "test-user",
      tokenType: "fine-grained",
      oauthScopes: [],
      hasRepoScope: true,
      hasWorkflowScope: true,
    });
    expect(result.ok).toBe(false);
  });
});
