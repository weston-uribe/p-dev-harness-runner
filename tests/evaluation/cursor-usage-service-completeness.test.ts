import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCursorUsageCsv } from "../../src/evaluation/cursor-usage-import/parse.js";
import {
  getAnalyticsFromLedgers,
  preflightCsvImport,
} from "../../src/evaluation/cursor-usage-import/service.js";
import type { ImportLedgerEntry } from "../../src/evaluation/cursor-usage-import/staging.js";
import { stagingDir } from "../../src/evaluation/cursor-usage-import/staging.js";

const CSV_HEADER =
  "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";

const VALID_ROW =
  "2026-07-19T12:00:00.000Z,bc-agent-planning-001,,Included,composer-2.5,false,100,200,300,50,650,Included";

const exportWindow = {
  startIso: "2026-07-19T00:00:00.000Z",
  endIso: "2026-07-20T00:00:00.000Z",
  timezone: "UTC",
  precision: "millisecond" as const,
  boundsSource: "cli_flags" as const,
};

function csvWithRows(...rows: string[]): string {
  return [CSV_HEADER, ...rows].join("\n");
}

describe("cursor usage parse rejection classes", () => {
  it("classifies blank Cloud Agent ID as non-attributable, not upload rejection", () => {
    const parsed = parseCursorUsageCsv(
      csvWithRows(
        VALID_ROW,
        "2026-07-19T12:01:00.000Z,,,Included,composer-2.5,false,0,150,400,25,575,Included",
      ),
    );
    expect(parsed.arithmetic.cloudAgentArithmeticComplete).toBe(true);
    expect(parsed.rejectionSummary.uploadScopedCount).toBe(0);
    const blank = parsed.rowEvidence.find((r) => r.agentCellBlank);
    expect(blank?.rowCapability).toBe("non_cloud_agent_usage");
    expect(blank?.rejectionClass).toBeNull();
    expect(parsed.rows).toHaveLength(1);
  });

  it("rejects invalid short Cloud Agent ID as upload_scoped_rejection", () => {
    const parsed = parseCursorUsageCsv(
      csvWithRows(
        "2026-07-19T12:01:00.000Z,abc,,Included,composer-2.5,false,0,150,400,25,575,Included",
      ),
    );
    expect(parsed.rejectionSummary.uploadScopedCount).toBe(1);
    expect(parsed.rowEvidence[0]?.rejectionReason).toBe("cloud_agent_id_invalid");
    expect(parsed.arithmetic.identityHolds).toBe(false);
  });

  it("does not create rejection for blank trailing CSV line", () => {
    const parsed = parseCursorUsageCsv(`${csvWithRows(VALID_ROW)}\n`);
    expect(parsed.rejectionSummary.uploadScopedCount).toBe(0);
    expect(parsed.rejectionSummary.agentScopedCount).toBe(0);
    expect(parsed.rows).toHaveLength(1);
  });

  it("does not create rejection for quoted empty optional Automation ID", () => {
    const parsed = parseCursorUsageCsv(
      csvWithRows(
        '2026-07-19T12:00:00.000Z,bc-agent-planning-001,"",Included,composer-2.5,false,100,200,300,50,650,Included',
      ),
    );
    expect(parsed.rejectionSummary.uploadScopedCount).toBe(0);
    expect(parsed.rejectionSummary.agentScopedCount).toBe(0);
    expect(parsed.arithmetic.identityHolds).toBe(true);
    expect(parsed.rows).toHaveLength(1);
  });

  it("stores rejection reason codes not raw cell contents", () => {
    const rawRejectedCell = "bad-id";
    const parsed = parseCursorUsageCsv(
      csvWithRows(
        `2026-07-19T12:01:00.000Z,${rawRejectedCell},,Included,composer-2.5,false,0,150,400,25,575,Included`,
      ),
    );
    expect(parsed.rejectionSummary.reasonCodes).toContain("cloud_agent_id_invalid");
    expect(parsed.rejectionSummary.reasonCodes).not.toContain(rawRejectedCell);
    for (const code of parsed.rejectionSummary.reasonCodes) {
      expect(code).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe("cursor usage preflight completeness", () => {
  it("preflight with blank-ID rows does not upload-reject; invalid nonblank still blocks", async () => {
    const logDirectory = mkdtempSync(
      path.join(tmpdir(), "cursor-usage-preflight-"),
    );
    const blankOk = await preflightCsvImport({
      csvBytes: csvWithRows(
        VALID_ROW,
        "2026-07-19T12:01:00.000Z,,,Included,composer-2.5,false,0,150,400,25,575,Included",
      ),
      exportWindow,
      namespace: "default",
      logDirectory,
      discoverLangfuse: false,
    });
    expect(blankOk.publicSummary.uploadScopedRejectionCount).toBe(0);
    expect(blankOk.publicSummary.nonCloudAgentExcludedRowCount).toBe(1);
    expect(blankOk.publicSummary.sourceCapabilityExclusionDigest).toBeTruthy();

    const blocked = await preflightCsvImport({
      csvBytes: csvWithRows(
        VALID_ROW,
        "2026-07-19T12:01:00.000Z,not-a-bc-id,,Included,composer-2.5,false,0,150,400,25,575,Included",
      ),
      exportWindow,
      namespace: "default",
      logDirectory,
      discoverLangfuse: false,
    });
    expect(blocked.sourceScopeComplete).toBe(false);
    expect(blocked.publicSummary.uploadScopedRejectionCount).toBeGreaterThan(0);
    expect(blocked.publicSummary.rejectionReasonCodes).toContain(
      "cloud_agent_id_invalid",
    );

    const summaryJson = JSON.stringify(blocked.publicSummary);
    expect(summaryJson).not.toContain("bc-agent-planning-001");
    expect(summaryJson).not.toContain("not-a-bc-id");
  });

  it("persists incomplete analytics diagnostics without contaminating verified totals", async () => {
    const logDirectory = mkdtempSync(
      path.join(tmpdir(), "cursor-usage-analytics-"),
    );
    const csv = csvWithRows(
      VALID_ROW,
      "2026-07-19T12:01:00.000Z,,,Included,composer-2.5,false,0,150,400,25,575,Included",
    );
    const result = await preflightCsvImport({
      csvBytes: csv,
      exportWindow,
      namespace: "default",
      logDirectory,
      discoverLangfuse: false,
    });
    expect(result.sourceScopeComplete).toBe(false);

    const ledgerPath = path.join(
      stagingDir(logDirectory, result.importId),
      "ledger.json",
    );
    const ledger = JSON.parse(
      readFileSync(ledgerPath, "utf8"),
    ) as ImportLedgerEntry;
    expect(ledger.analyticsSummary).toBeDefined();
    expect(ledger.analyticsSummary!.verifiedTotalsIncluded).toBe(false);
    expect(ledger.analyticsSummary!.unresolvedSegmentCount).toBeGreaterThan(0);
    expect(
      Object.keys(ledger.analyticsSummary!.byIssue).length +
        Object.keys(ledger.analyticsSummary!.byPhase).length,
    ).toBe(0);

    const analytics = await getAnalyticsFromLedgers(logDirectory);
    expect(analytics.unresolvedSegmentCount).toBeGreaterThan(0);
    expect(Object.keys(analytics.grouped.byIssue)).toHaveLength(0);
    expect(analytics.verifiedCount).toBe(0);
  });

  it("verified ledger analytics survive reading only ledger files from disk", async () => {
    const logDirectory = mkdtempSync(
      path.join(tmpdir(), "cursor-usage-analytics-verified-"),
    );
    const importId = "verified-import-restart";
    const dir = stagingDir(logDirectory, importId);
    mkdirSync(dir, { recursive: true });
    const ledger: ImportLedgerEntry = {
      schemaVersion: 1,
      importId,
      recordedAt: new Date().toISOString(),
      lifecycle: "verified",
      namespace: "default",
      sourceDigestSha256: "abc123digest",
      exportWindow,
      bundleCount: 1,
      scoreCount: 12,
      verified: true,
      sourceScopeComplete: true,
      localEvidenceCompleteness: "complete",
      langfuseReconciliationStatus: "not_run",
      analyticsSummary: {
        byIssue: {
          "TT-FIXTURE": {
            bundles: 1,
            inputTokens: 200,
            cacheWriteTokens: 100,
            cacheReadTokens: 300,
            outputTokens: 50,
            totalTokens: 650,
            providerActualUsd: null,
            knownNoncacheCostUsd: 0.01,
            allInputAtListRateUsd: 0.02,
            completeness: "complete",
            coverage: "verified",
          },
        },
        byPhase: {
          planning: {
            bundles: 1,
            inputTokens: 200,
            cacheWriteTokens: 100,
            cacheReadTokens: 300,
            outputTokens: 50,
            totalTokens: 650,
            providerActualUsd: null,
            knownNoncacheCostUsd: 0.01,
            allInputAtListRateUsd: 0.02,
            completeness: "complete",
            coverage: "verified",
          },
        },
        bySourceModel: {
          "composer-2.5": {
            bundles: 1,
            inputTokens: 200,
            cacheWriteTokens: 100,
            cacheReadTokens: 300,
            outputTokens: 50,
            totalTokens: 650,
            providerActualUsd: null,
            knownNoncacheCostUsd: 0.01,
            allInputAtListRateUsd: 0.02,
            completeness: "complete",
            coverage: "verified",
          },
        },
        byCanonicalModel: {
          "composer-2.5": {
            bundles: 1,
            inputTokens: 200,
            cacheWriteTokens: 100,
            cacheReadTokens: 300,
            outputTokens: 50,
            totalTokens: 650,
            providerActualUsd: null,
            knownNoncacheCostUsd: 0.01,
            allInputAtListRateUsd: 0.02,
            completeness: "complete",
            coverage: "verified",
          },
        },
        byEffectiveVariant: {
          standard: {
            bundles: 1,
            inputTokens: 200,
            cacheWriteTokens: 100,
            cacheReadTokens: 300,
            outputTokens: 50,
            totalTokens: 650,
            providerActualUsd: null,
            knownNoncacheCostUsd: 0.01,
            allInputAtListRateUsd: 0.02,
            completeness: "complete",
            coverage: "verified",
          },
        },
        bySourceDigest: {
          abc123digestxxxxx: {
            bundles: 1,
            inputTokens: 200,
            cacheWriteTokens: 100,
            cacheReadTokens: 300,
            outputTokens: 50,
            totalTokens: 650,
            providerActualUsd: null,
            knownNoncacheCostUsd: 0.01,
            allInputAtListRateUsd: 0.02,
            completeness: "complete",
            coverage: "verified",
          },
        },
        byPricingRegistryVersion: {
          "2026-07-18.v2": {
            bundles: 1,
            inputTokens: 200,
            cacheWriteTokens: 100,
            cacheReadTokens: 300,
            outputTokens: 50,
            totalTokens: 650,
            providerActualUsd: null,
            knownNoncacheCostUsd: 0.01,
            allInputAtListRateUsd: 0.02,
            completeness: "complete",
            coverage: "verified",
          },
        },
        sourceDigestPrefix: "abc123digestxxxxx".slice(0, 16),
        importId,
        pricingRegistryVersion: "2026-07-18.v2",
        unresolvedSegmentCount: 0,
        pricingIncompleteSegmentCount: 0,
        verifiedTotalsIncluded: true,
      },
    };
    writeFileSync(path.join(dir, "ledger.json"), `${JSON.stringify(ledger)}\n`);

    const analytics = await getAnalyticsFromLedgers(logDirectory);
    expect(analytics.verifiedCount).toBe(1);
    expect(analytics.grouped.byIssue["TT-FIXTURE"]?.inputTokens).toBe(200);
    expect(analytics.grouped.byPhase.planning?.totalTokens).toBe(650);
    expect(analytics.grouped.bySourceModel["composer-2.5"]?.bundles).toBe(1);
    expect(analytics.grouped.byEffectiveVariant.standard?.bundles).toBe(1);
    expect(Object.keys(analytics.grouped.bySourceDigest).length).toBe(1);
    expect(Object.keys(analytics.grouped.byPricingRegistryVersion).length).toBe(
      1,
    );
  });
});
