import { describe, expect, it } from "vitest";
import {
  deriveRowCapabilityFromEvidence,
  parseCursorUsageCsv,
  recomputeArithmeticFromEvidence,
} from "../../src/evaluation/cursor-usage-import/parse.js";
import { inspectCursorUsageCsvSource } from "../../src/evaluation/cursor-usage-import/source-inspection.js";
import { buildSourceCapabilityExclusionManifest } from "../../src/evaluation/cursor-usage-import/capability-exclusion.js";
import { CANONICAL_USAGE_SCHEMA_VERSION, SCORE_CONTRACT_VERSION } from "../../src/evaluation/cursor-usage-import/canonical.js";
import { CURSOR_USAGE_IMPORTER_VERSION } from "../../src/evaluation/cursor-usage-import/types.js";
import { PARSER_SCHEMA_VERSION } from "../../src/evaluation/cursor-usage-import/parse.js";
import { IMPORT_SCOPE_ID } from "../../src/evaluation/cursor-usage-import/import-scope.js";

const CSV_HEADER =
  "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";

function csv(...rows: string[]): string {
  return [CSV_HEADER, ...rows].join("\n");
}

describe("cursor usage observed window + classification", () => {
  it("infers min/max from newest-first CSV without reversing window", () => {
    const raw = csv(
      "2026-07-22T16:47:19.615Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included",
      "2026-07-16T01:27:44.299Z,bc-agent-planning-001,,Included,composer-2.5,false,0,10,0,5,15,Included",
    );
    const inspection = inspectCursorUsageCsvSource(raw);
    expect(inspection.sortOrder).toBe("descending");
    expect(inspection.minTimestampIso).toBe("2026-07-16T01:27:44.299Z");
    expect(inspection.maxTimestampIso).toBe("2026-07-22T16:47:19.615Z");
    expect(inspection.observedWindow?.startIso).toBe(
      "2026-07-16T01:27:44.299Z",
    );
    expect(inspection.observedWindow?.endIso).toBe("2026-07-22T16:47:19.615Z");
    expect(inspection.timezoneEvidence).toBe("UTC");
    expect(inspection.timestampPrecision).toBe("millisecond");
  });

  it("infers identical min/max for ascending and unsorted CSV", () => {
    const ascending = csv(
      "2026-07-16T01:27:44.299Z,bc-agent-planning-001,,Included,composer-2.5,false,0,10,0,5,15,Included",
      "2026-07-22T16:47:19.615Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included",
    );
    const unsorted = csv(
      "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,0,10,0,5,15,Included",
      "2026-07-16T01:27:44.299Z,bc-agent-planning-001,,Included,composer-2.5,false,0,10,0,5,15,Included",
      "2026-07-22T16:47:19.615Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included",
    );
    const a = inspectCursorUsageCsvSource(ascending);
    const u = inspectCursorUsageCsvSource(unsorted);
    expect(a.sortOrder).toBe("ascending");
    expect(u.sortOrder).toBe("unsorted");
    expect(a.minTimestampIso).toBe(u.minTimestampIso);
    expect(a.maxTimestampIso).toBe(u.maxTimestampIso);
  });

  it("normalizes explicit offset timestamps to UTC", () => {
    const raw = csv(
      "2026-07-19T05:00:00.000-07:00,bc-agent-planning-001,,Included,composer-2.5,false,0,10,0,5,15,Included",
    );
    const inspection = inspectCursorUsageCsvSource(raw);
    expect(inspection.minTimestampIso).toBe("2026-07-19T12:00:00.000Z");
    expect(inspection.timezoneEvidence).toBe("explicit_offsets_normalized");
  });

  it("leaves offset-free timestamps unproven without assumedTimezone", () => {
    const raw = csv(
      "2026-07-19T12:00:00.000,bc-agent-planning-001,,Included,composer-2.5,false,0,10,0,5,15,Included",
    );
    const inspection = inspectCursorUsageCsvSource(raw);
    expect(inspection.timezoneEvidence).toBe("unproven");
    expect(inspection.observedWindow).toBeNull();
    expect(inspection.validTimestampCount).toBe(0);
  });

  it("accepts offset-free timestamps with validated IANA assumedTimezone", () => {
    const raw = csv(
      "2026-07-19T12:00:00.000,bc-agent-planning-001,,Included,composer-2.5,false,0,10,0,5,15,Included",
    );
    const inspection = inspectCursorUsageCsvSource(raw, {
      assumedTimezone: "UTC",
    });
    expect(inspection.timezoneEvidence).toBe("assumed_iana");
    expect(inspection.observedWindow?.startIso).toBe("2026-07-19T12:00:00.000Z");
  });

  it("classifies blank-ID token rows as non-cloud usage with aggregate arithmetic", () => {
    const parsed = parseCursorUsageCsv(
      csv(
        "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included",
        "2026-07-19T12:01:00.000Z,,,Included,composer-2.5,false,10,20,30,5,65,Included",
      ),
    );
    expect(parsed.classificationCounts.nonCloudAgentUsage).toBe(1);
    expect(parsed.rejectionSummary.uploadScopedCount).toBe(0);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.arithmetic.cloudAgentArithmeticComplete).toBe(true);
    const blank = parsed.rowEvidence.find((r) => r.agentCellBlank)!;
    expect(blank.rowCapability).toBe("non_cloud_agent_usage");
    expect(blank.sourceCapabilityExclusionFingerprint).toBeTruthy();
  });

  it("supports explicit no-token errored/no-charge rule v1", () => {
    const parsed = parseCursorUsageCsv(
      csv(
        "2026-07-19T12:00:00.000Z,,,Errored,composer-2.5,false,,,,,,No Charge",
      ),
    );
    expect(parsed.classificationCounts.nonCloudAgentNoTokenEvent).toBe(1);
    expect(parsed.rowEvidence[0]?.rowCapability).toBe(
      "non_cloud_agent_no_token_event",
    );
    expect(parsed.rejectionSummary.uploadScopedCount).toBe(0);
    expect(parsed.rows).toHaveLength(0);
  });

  it("does not treat blank-ID missing tokens without rule as no-token event", () => {
    const parsed = parseCursorUsageCsv(
      csv("2026-07-19T12:00:00.000Z,,,Included,composer-2.5,false,,,,,Included"),
    );
    expect(parsed.classificationCounts.nonCloudAgentNoTokenEvent).toBe(0);
    expect(parsed.rowEvidence[0]?.rowCapability).toBe("non_cloud_agent_invalid");
  });

  it("blocks invalid nonblank Cloud Agent IDs as upload-scoped", () => {
    const parsed = parseCursorUsageCsv(
      csv(
        "2026-07-19T12:00:00.000Z,xy-not-bc,,Included,composer-2.5,false,0,10,0,5,15,Included",
      ),
    );
    expect(parsed.rejectionSummary.uploadScopedCount).toBe(1);
    expect(parsed.rowEvidence[0]?.rowCapability).toBe(
      "invalid_nonblank_agent_identity",
    );
  });

  it("preserves cache-write and cache-read buckets with exact arithmetic", () => {
    const parsed = parseCursorUsageCsv(
      csv(
        "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included",
      ),
    );
    expect(parsed.rows[0]?.tokens).toEqual({
      inputTokens: 200,
      cacheWriteTokens: 100,
      cacheReadTokens: 300,
      outputTokens: 50,
      totalTokens: 650,
    });
    const inspection = inspectCursorUsageCsvSource(
      csv(
        "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included",
      ),
    );
    expect(inspection.tokenBucketTotals.cacheWriteTokens).toBe(100);
    expect(inspection.tokenBucketTotals.cacheReadTokens).toBe(300);
    expect(inspection.tokenBucketNonzeroCounts.cacheWriteTokens).toBe(1);
    expect(inspection.tokenBucketNonzeroCounts.cacheReadTokens).toBe(1);
  });

  it("marks agent-scoped arithmetic failure without blocking unrelated non-cloud rows", () => {
    const parsed = parseCursorUsageCsv(
      csv(
        "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,999,Included",
        "2026-07-19T12:01:00.000Z,,,Included,composer-2.5,false,10,20,30,5,65,Included",
      ),
    );
    expect(parsed.arithmetic.cloudAgentArithmeticComplete).toBe(false);
    expect(parsed.arithmetic.nonCloudAggregateArithmeticComplete).toBe(true);
    expect(parsed.rejectionSummary.agentScopedCount).toBe(1);
    expect(parsed.rejectionSummary.uploadScopedCount).toBe(0);
  });

  it("keeps aggregate-only arithmetic failures from gating cloud-agent completeness", () => {
    const parsed = parseCursorUsageCsv(
      csv(
        "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included",
        "2026-07-19T12:01:00.000Z,,,Included,composer-2.5,false,10,20,30,5,999,Included",
      ),
    );
    expect(parsed.arithmetic.cloudAgentArithmeticComplete).toBe(true);
    expect(parsed.arithmetic.nonCloudAggregateArithmeticComplete).toBe(false);
    expect(parsed.arithmetic.allParsedRowsArithmeticComplete).toBe(false);
    const rebuilt = recomputeArithmeticFromEvidence(parsed.rowEvidence);
    expect(rebuilt.cloudAgentArithmeticComplete).toBe(true);
    expect(rebuilt.nonCloudAggregateArithmeticComplete).toBe(false);
  });

  it("builds source capability exclusion manifest digest", () => {
    const parsed = parseCursorUsageCsv(
      csv(
        "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included",
        "2026-07-19T12:01:00.000Z,,,Included,composer-2.5,false,10,20,30,5,65,Included",
        "2026-07-19T12:02:00.000Z,,,Errored,composer-2.5,false,,,,,,No Charge",
      ),
    );
    const manifest = buildSourceCapabilityExclusionManifest(parsed.rowEvidence);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/);
    for (const row of parsed.rowEvidence) {
      expect(deriveRowCapabilityFromEvidence(row)).toBe(row.rowCapability);
    }
  });

  it("bumps importer/parser/canonical/score contract versions", () => {
    expect(PARSER_SCHEMA_VERSION).toBe(2);
    expect(CANONICAL_USAGE_SCHEMA_VERSION).toBe(2);
    expect(CURSOR_USAGE_IMPORTER_VERSION).toBe("14.0.0");
    expect(SCORE_CONTRACT_VERSION).toBe("11.0.0");
    expect(IMPORT_SCOPE_ID).toBe("pdev_cloud_agent_trace_enrichment_v1");
  });
});
