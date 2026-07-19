import { describe, expect, it } from "vitest";
import {
  canInvalidatePreviewDuringPolling,
  INITIAL_APPLY_STATUS_MESSAGE,
  isRedeployPollingActive,
  resolveOrchestrationStatusMessage,
  shouldHideApplyButton,
  shouldShowTerminalApplyResult,
} from "../../apps/gui/lib/vercel-bridge-polling-ui";

describe("vercel-bridge-polling-ui", () => {
  it("treats setupPending, pollActionId, or active orchestration as polling", () => {
    expect(
      isRedeployPollingActive({ setupPending: true, pollActionId: null }),
    ).toBe(true);
    expect(
      isRedeployPollingActive({ setupPending: false, pollActionId: "action-1" }),
    ).toBe(true);
    expect(
      isRedeployPollingActive({
        setupPending: false,
        pollActionId: null,
        orchestration: { active: true },
      }),
    ).toBe(true);
    expect(
      isRedeployPollingActive({ setupPending: false, pollActionId: null }),
    ).toBe(false);
  });

  it("blocks preview invalidation while polling unless forced", () => {
    expect(canInvalidatePreviewDuringPolling(true)).toBe(false);
    expect(canInvalidatePreviewDuringPolling(true, { force: true })).toBe(true);
    expect(canInvalidatePreviewDuringPolling(false)).toBe(true);
  });

  it("shows only generic applying copy during the initial apply request", () => {
    expect(
      resolveOrchestrationStatusMessage({
        loading: "apply",
      }),
    ).toBe(INITIAL_APPLY_STATUS_MESSAGE);
  });

  it("prefers server orchestration status after apply returns", () => {
    expect(
      resolveOrchestrationStatusMessage({
        loading: null,
        applyResult: {
          orchestrationStatusMessage: "Waiting for the production deployment…",
        } as never,
      }),
    ).toBe("Waiting for the production deployment…");
  });

  it("hides Apply while orchestration is active or already verified", () => {
    expect(
      shouldHideApplyButton({ verifiedSuccess: false, redeployPollingActive: true }),
    ).toBe(true);
    expect(
      shouldHideApplyButton({ verifiedSuccess: true, redeployPollingActive: false }),
    ).toBe(true);
  });

  it("suppresses terminal cards while orchestration remains active", () => {
    expect(
      shouldShowTerminalApplyResult({
        applyResult: { setupBlocked: { message: "blocked", nextSteps: [] } } as never,
        orchestration: { active: true },
        redeployPollingActive: true,
      }),
    ).toBe(false);
  });
});
