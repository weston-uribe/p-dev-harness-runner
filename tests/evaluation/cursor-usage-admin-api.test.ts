import { describe, expect, it } from "vitest";
import {
  normalizeAdminEvent,
  type AdminUsageEvent,
} from "../../src/evaluation/cursor-usage-import/sources/admin-api.js";
import {
  attributeSegmentsToCandidates,
  buildSegmentsFromCanonicalEvents,
} from "../../src/evaluation/cursor-usage-import/attribution.js";

/** Documented Admin API response fixture shape. */
const FIXTURE_EVENT: AdminUsageEvent = {
  timestamp: "2026-07-19T12:00:00.000Z",
  model: "composer-2.5",
  kind: "Included",
  maxMode: "false",
  requestsCosts: 42,
  isTokenBasedCall: true,
  tokenUsage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 10,
    cacheReadTokens: 20,
    totalCents: "12.3456",
  },
  isFreeBugbot: false,
  userEmail: "user@example.com",
};

describe("cursor admin api normalization", () => {
  it("normalizes documented response shape to aggregate_only", () => {
    const canonical = normalizeAdminEvent({
      event: FIXTURE_EVENT,
      sourceDigestOrQueryId: "query-1",
    });
    expect(canonical.capability).toBe("aggregate_only");
    expect(canonical.billingCategory).toBe("aggregate_only");
    expect(canonical.cloudAgentId).toBeNull();
    expect(canonical.sourceType).toBe("cursor_admin_api");
  });

  it("converts totalCents to providerActualUsdMicros when isTokenBasedCall", () => {
    const canonical = normalizeAdminEvent({
      event: FIXTURE_EVENT,
      sourceDigestOrQueryId: "query-1",
    });
    expect(canonical.providerActualUsdMicros).toBe("123456");
    expect(canonical.isTokenBased).toBe(true);
  });

  it("does not treat requestsCosts as USD", () => {
    const canonical = normalizeAdminEvent({
      event: FIXTURE_EVENT,
      sourceDigestOrQueryId: "query-1",
    });
    expect(canonical.warnings).toContain("requestsCosts_not_usd");
    expect(canonical.providerActualUsdMicros).not.toBe("42");
    expect(canonical.providerActualUsdMicros).toBe("123456");
  });

  it("does not use undocumented fields for attribution", () => {
    const withExtra = {
      ...FIXTURE_EVENT,
      // Undocumented fields that must not drive attribution
      cloudAgentId: "bc-should-not-attach",
      issueKey: "TT-999",
      phase: "implementation",
    } as AdminUsageEvent & {
      cloudAgentId: string;
      issueKey: string;
      phase: string;
    };

    const canonical = normalizeAdminEvent({
      event: withExtra,
      sourceDigestOrQueryId: "query-1",
    });
    expect(canonical.cloudAgentId).toBeNull();

    const segments = buildSegmentsFromCanonicalEvents([canonical]);
    expect(segments).toHaveLength(0);

    const attributed = attributeSegmentsToCandidates({
      segments,
      candidates: [
        {
          traceId: "trace-1",
          sessionId: "a".repeat(64),
          timestamp: null,
          cursorAgentId: "bc-should-not-attach",
          cursorAgentIdHash: null,
          issueKey: "TT-999",
          phase: "implementation",
          phaseExecutionId: null,
          harnessRunId: null,
          windowStart: null,
          windowEnd: null,
          model: null,
          effectiveVariant: "standard",
          existingCursorScoreNames: [],
        },
      ],
      canonicalEvents: [canonical],
    });
    expect(attributed).toHaveLength(0);
  });

  it("skips provider actual when isTokenBasedCall is false", () => {
    const canonical = normalizeAdminEvent({
      event: {
        ...FIXTURE_EVENT,
        isTokenBasedCall: false,
      },
      sourceDigestOrQueryId: "query-1",
    });
    expect(canonical.providerActualUsdMicros).toBeNull();
  });
});
