import { describe, expect, it } from "vitest";
import {
  REMOTE_SETUP_ACTIONS,
  assertRemoteSetupConfirmed,
  assertRemoteSetupFingerprint,
  assertRemoteSetupPermissionScope,
} from "../../src/setup/remote-actions.js";
import { SETUP_ACTIONS } from "../../src/setup/setup-actions.js";
import { SETUP_PERMISSIONS } from "../../src/setup/permission-model.js";

describe("remote-actions", () => {
  it("maps remote setup actions to expected permission scopes", () => {
    expect(SETUP_ACTIONS.previewHarnessSecrets.permission).toEqual(
      SETUP_PERMISSIONS.remoteRead,
    );
    expect(SETUP_ACTIONS.applyHarnessSecrets.permission).toEqual(
      SETUP_PERMISSIONS.remoteSecretWrite,
    );
    expect(SETUP_ACTIONS.previewTargetWorkflowPr.permission).toEqual(
      SETUP_PERMISSIONS.remoteRead,
    );
    expect(SETUP_ACTIONS.applyTargetWorkflowPr.permission).toEqual(
      SETUP_PERMISSIONS.remoteRepoWrite,
    );
  });

  it("rejects missing confirmation", () => {
    expect(() => assertRemoteSetupConfirmed(false)).toThrow(/confirmation/);
  });

  it("rejects stale preview fingerprint", () => {
    expect(() =>
      assertRemoteSetupFingerprint("stale", "current"),
    ).toThrow(/stale/i);
  });

  it("rejects wrong permission scope", () => {
    expect(() =>
      assertRemoteSetupPermissionScope(
        "remote-read",
        REMOTE_SETUP_ACTIONS.applyHarnessSecrets.permission.scope,
      ),
    ).toThrow(/permission scope/i);
  });
});
