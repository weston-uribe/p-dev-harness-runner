import { describe, expect, it } from "vitest";
import { isUnifiedDataSharingEnabled } from "../../apps/gui/lib/observability-preferences.js";
import { resolveSourceGuiObservabilityNonce } from "../../src/observability/session-handoff.js";
import { P_DEV_OBSERVABILITY_NONCE_ENV } from "../../src/observability/constants.js";

describe("observability preferences helpers", () => {
  it("treats unified sharing as enabled only when both preferences are enabled", () => {
    expect(
      isUnifiedDataSharingEnabled({
        analyticsPreference: "enabled",
        errorReportingPreference: "enabled",
      }),
    ).toBe(true);
    expect(
      isUnifiedDataSharingEnabled({
        analyticsPreference: "enabled",
        errorReportingPreference: "disabled",
      }),
    ).toBe(false);
    expect(
      isUnifiedDataSharingEnabled({
        analyticsPreference: null,
        errorReportingPreference: null,
      }),
    ).toBe(false);
  });
});

describe("resolveSourceGuiObservabilityNonce", () => {
  it("preserves an explicitly supplied nonce", () => {
    const explicit = "explicit-test-nonce-value";
    expect(
      resolveSourceGuiObservabilityNonce({
        [P_DEV_OBSERVABILITY_NONCE_ENV]: explicit,
      }),
    ).toBe(explicit);
  });

  it("generates a nonce when one is not supplied", () => {
    const generated = resolveSourceGuiObservabilityNonce({});
    expect(generated.length).toBeGreaterThan(10);
  });
});
