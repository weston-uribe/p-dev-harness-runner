import { describe, expect, it } from "vitest";
import {
  loadDurableServiceConnectionSummaries,
  resolveServiceConnectionBadgeState,
  serviceVerificationFromSummaries,
} from "../../apps/gui/lib/verification-state";

describe("Settings connection health badges", () => {
  it("saved token presence initially renders Checking, not Connected", () => {
    const summaries = loadDurableServiceConnectionSummaries({
      LINEAR_API_KEY: true,
      CURSOR_API_KEY: false,
      GITHUB_TOKEN: true,
      VERCEL_TOKEN: true,
    });
    expect(summaries.VERCEL_TOKEN.status).toBe("checking");
    expect(summaries.VERCEL_TOKEN.status).not.toBe("connected");
    expect(summaries.CURSOR_API_KEY.status).toBe("missing");

    const verification = serviceVerificationFromSummaries(summaries);
    expect(verification.VERCEL_TOKEN.state).toBe("checking");
    const badge = resolveServiceConnectionBadgeState(
      true,
      verification.VERCEL_TOKEN,
      "",
    );
    expect(badge).toBe("checking");
  });

  it("unauthorized saved token renders Unauthorized typed status", () => {
    const verification = serviceVerificationFromSummaries({
      LINEAR_API_KEY: { status: "missing" },
      CURSOR_API_KEY: { status: "missing" },
      GITHUB_TOKEN: { status: "missing" },
      VERCEL_TOKEN: {
        status: "unauthorized",
        message: "Vercel rejected this token.",
      },
    });
    expect(verification.VERCEL_TOKEN.state).toBe("unauthorized");
    const badge = resolveServiceConnectionBadgeState(
      true,
      verification.VERCEL_TOKEN,
      "",
    );
    expect(badge).toBe("unauthorized");
  });
});
