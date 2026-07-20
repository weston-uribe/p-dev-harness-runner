import { describe, expect, it } from "vitest";
import { shouldAcceptHealthRefresh } from "../../src/setup/workspace-health.js";

describe("workspace health stale-response handling", () => {
  it("discards verify responses when the control-plane fingerprint drifted", () => {
    expect(
      shouldAcceptHealthRefresh({
        mountedControlPlaneFingerprint: "mount-a",
        responseControlPlaneFingerprint: "mount-b",
      }),
    ).toBe(false);
  });

  it("accepts verify responses that match the mounted snapshot", () => {
    expect(
      shouldAcceptHealthRefresh({
        mountedControlPlaneFingerprint: "mount-a",
        responseControlPlaneFingerprint: "mount-a",
      }),
    ).toBe(true);
  });

  it("rejects missing response fingerprints", () => {
    expect(
      shouldAcceptHealthRefresh({
        mountedControlPlaneFingerprint: "mount-a",
        responseControlPlaneFingerprint: undefined,
      }),
    ).toBe(false);
  });
});
