import { describe, expect, it } from "vitest";
import { deriveStep6AutomaticControlState } from "../../src/setup/step6-automatic-control-state.js";

const baseInput = {
  setupType: "automatic" as const,
  confirmed: false,
  loading: null,
  remoteActionsBlocked: false,
  automaticOutcomeKind: "idle" as const,
  cloudSecretsPreviewOpened: false,
  remoteSecretPreviewStale: false,
};

describe("deriveStep6AutomaticControlState", () => {
  it("enables confirm without preview when automatic path is eligible", () => {
    const state = deriveStep6AutomaticControlState(baseInput);
    expect(state.confirmDisabled).toBe(false);
    expect(state.confirmDisabledReason).toBeUndefined();
  });

  it("enables apply after confirm without preview", () => {
    const state = deriveStep6AutomaticControlState({
      ...baseInput,
      confirmed: true,
    });
    expect(state.applyDisabled).toBe(false);
    expect(state.applyDisabledReason).toBeUndefined();
  });

  it("does not treat never-opened preview as stale blocker", () => {
    const state = deriveStep6AutomaticControlState({
      ...baseInput,
      remoteSecretPreviewStale: true,
      cloudSecretsPreviewOpened: false,
    });
    expect(state.stalePreviewBlockerActive).toBe(false);
  });

  it("activates stale preview blocker only when preview was opened", () => {
    const state = deriveStep6AutomaticControlState({
      ...baseInput,
      remoteSecretPreviewStale: true,
      cloudSecretsPreviewOpened: true,
    });
    expect(state.stalePreviewBlockerActive).toBe(true);
  });

  it("blocks apply while remote actions are blocked", () => {
    const state = deriveStep6AutomaticControlState({
      ...baseInput,
      confirmed: true,
      remoteActionsBlocked: true,
      remoteActionsBlockedReason: "Harness repo access is missing.",
    });
    expect(state.confirmDisabled).toBe(true);
    expect(state.applyDisabled).toBe(true);
    expect(state.confirmDisabledReason).toBe(
      "Harness repo access is missing.",
    );
  });

  it("blocks apply after automatic success is already verified", () => {
    const state = deriveStep6AutomaticControlState({
      ...baseInput,
      confirmed: true,
      automaticOutcomeKind: "success",
    });
    expect(state.applyDisabled).toBe(true);
    expect(state.applyDisabledReason).toBe(
      "Automatic secret write already verified for the current config.",
    );
  });
});
