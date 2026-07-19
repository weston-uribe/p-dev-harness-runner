import { describe, expect, it, vi } from "vitest";
import {
  logVercelBridgeEvent,
  sanitizeVercelBridgeLogEvent,
} from "../../src/setup/vercel-bridge-structured-log.js";

describe("vercel-bridge-structured-log", () => {
  it("sanitizes setupBlocked messages that mention secret env keys", () => {
    const sanitized = sanitizeVercelBridgeLogEvent({
      phase: "blocked",
      setupBlockedMessage:
        "Cannot resume because LINEAR_WEBHOOK_SECRET mismatch with VERCEL_TOKEN",
      setupBlockedNextSteps: [
        "Confirm GITHUB_TOKEN is saved in Step 1.",
      ],
    });

    expect(sanitized.setupBlockedMessage).toBe("[redacted]");
    expect(sanitized.setupBlockedNextSteps).toEqual(["[redacted]"]);
  });

  it("does not include raw secrets in console output", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logVercelBridgeEvent({
      phase: "apply_complete",
      actionId: "apply-vercel-bridge",
      fingerprint: "abc123",
      envWritePlan: [
        { key: "LINEAR_WEBHOOK_SECRET", action: "create", source: "generated" },
      ],
      signedProbeResult: "auth_failed",
      signedProbeReason: "invalid_signature",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = String(logSpy.mock.calls[0]?.[0]);
    expect(output).toMatch(/^\[setup:vercel-bridge\]/);
    expect(output).not.toContain("super-secret-value");
    expect(output).toContain("invalid_signature");
    expect(output).toContain("LINEAR_WEBHOOK_SECRET");

    logSpy.mockRestore();
  });
});
