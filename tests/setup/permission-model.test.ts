import { describe, expect, it } from "vitest";
import {
  classifySetupPermission,
  SETUP_PERMISSIONS,
} from "../../src/setup/permission-model.js";
import { SETUP_ACTIONS } from "../../src/setup/setup-actions.js";

describe("permission-model", () => {
  it("classifies local file writes as standard confirmation", () => {
    const permission = classifySetupPermission("local-file-write");

    expect(permission.scope).toBe("local-file-write");
    expect(permission.confirmation).toBe("standard");
    expect(permission.manualAlternative).toBe(true);
  });

  it("classifies remote secret writes as strong confirmation", () => {
    const permission = classifySetupPermission("remote-secret-write");

    expect(permission.confirmation).toBe("strong");
    expect(permission.manualAlternative).toBe(true);
  });

  it("maps setup actions to expected permission scopes", () => {
    expect(SETUP_ACTIONS.scaffoldEnvLocal.permission).toEqual(
      SETUP_PERMISSIONS.localFileWrite,
    );
    expect(SETUP_ACTIONS.generateGitHubSecretInstructions.permission).toEqual(
      SETUP_PERMISSIONS.readOnly,
    );
    expect(SETUP_ACTIONS.applyHarnessSecrets.permission).toEqual(
      SETUP_PERMISSIONS.remoteSecretWrite,
    );
    expect(SETUP_ACTIONS.applyTargetWorkflowPr.permission).toEqual(
      SETUP_PERMISSIONS.remoteRepoWrite,
    );
  });
});
