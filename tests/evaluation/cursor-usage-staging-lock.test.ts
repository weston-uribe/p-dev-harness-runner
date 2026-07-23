import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireImportLock,
  canonicalImportIdentity,
} from "../../src/evaluation/cursor-usage-import/import-lock.js";
import {
  createImportId,
  writeStagingArtifacts,
  readStagingArtifacts,
} from "../../src/evaluation/cursor-usage-import/staging.js";
import type { ExportWindow } from "../../src/evaluation/cursor-usage-import/canonical.js";
import { CURSOR_USAGE_IMPORTER_VERSION } from "../../src/evaluation/cursor-usage-import/types.js";
import { SCORE_CONTRACT_VERSION } from "../../src/evaluation/cursor-usage-import/canonical.js";

describe("cursor-usage staging + canonical lock", () => {
  const exportWindow: ExportWindow = {
    startIso: "2026-07-19T00:00:00.000Z",
    endIso: "2026-07-20T00:00:00.000Z",
    timezone: "UTC",
    precision: "millisecond",
    boundsSource: "cli_flags",
  };

  const identityInput = {
    namespace: "weston-dogfood",
    environment: "default",
    sourceType: "cursor_csv" as const,
    sourceDigestOrQueryIdentity: "abc123",
    normalizedFilters: { phases: ["planning"] },
    exportWindow,
    importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
    scoreContractVersion: SCORE_CONTRACT_VERSION,
  };

  it("derives the same canonical identity for the same CSV digest and filters", () => {
    const a = canonicalImportIdentity(identityInput);
    const b = canonicalImportIdentity({ ...identityInput });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("acquires and releases a lock; second CSV upload shares identity hash", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cu-lock-"));
    const importId1 = createImportId();
    const handle = await acquireImportLock({
      logDirectory,
      importId: importId1,
      identity: identityInput,
    });
    expect(handle.importId).toBe(importId1);
    // Same identity for a second upload of the same CSV
    expect(canonicalImportIdentity(identityInput)).toBe(
      canonicalImportIdentity({
        ...identityInput,
        // different UI import id is irrelevant to lock key
      }),
    );
    // Concurrent hold: lock file already exists with wx semantics
    const lockPath = handle.lockPath;
    await expect(open(lockPath, "wx")).rejects.toMatchObject({ code: "EEXIST" });
    await handle.release();
    const again = await acquireImportLock({
      logDirectory,
      importId: createImportId(),
      identity: identityInput,
    });
    await again.release();
  });

  it("recovers staging artifacts after write (refresh/restart durable)", async () => {
    const logDirectory = mkdtempSync(path.join(tmpdir(), "cu-stage-"));
    const importId = createImportId();
    await writeStagingArtifacts(logDirectory, importId, {
      canonicalEvents: [
        {
          sourceType: "cursor_csv",
          sourceSchemaVersion: 1,
          importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
          sourceEventFingerprint: "fp1",
          sourceDigestOrQueryId: "digest",
          timestampIso: "2026-07-19T12:00:00.000Z",
          cloudAgentId: "bc-agent-full-private-id-001",
          automationId: null,
          modelRaw: "composer-2.5",
          modelIdCanonical: "composer-2.5",
          sourceMaxMode: "false",
          sourceFastHint: "unknown",
          kind: "Included",
          billingCategory: "included_like",
          tokens: {
            inputTokens: 1,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 1,
            totalTokens: 2,
          },
          providerActualUsdMicros: null,
          isTokenBased: null,
          includedInPlan: true,
          capability: "issue_phase_scores",
          warnings: [],
        },
      ],
      preflight: {
        schemaVersion: 1,
        importId,
        preparedAt: new Date().toISOString(),
        importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
        namespace: "ns",
        environment: null,
        sourceDigestSha256: "digest",
        exportWindow,
        fingerprint: "fp",
        lifecycle: "preflighted",
        candidateCount: 0,
        bundleCount: 0,
        sourceScopeComplete: false,
        sourceScopeIncompleteReason: "export_window_unproven",
        canonicalEventCount: 1,
      },
      publicSummary: {
        schemaVersion: 1,
        kind: "cursor_usage_import_staging_public",
        importId,
        preparedAt: new Date().toISOString(),
        importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
        lifecycle: "preflighted",
        namespace: "ns",
        sourceDigestPrefix: "digest".slice(0, 16),
        bundleCount: 0,
        sourceScopeComplete: false,
        observationMutationAttempted: false,
      },
      ledger: {
        schemaVersion: 1,
        importId,
        recordedAt: new Date().toISOString(),
        lifecycle: "preflighted",
        namespace: "ns",
        sourceDigestSha256: "digest",
        exportWindow,
        bundleCount: 0,
        scoreCount: 0,
        verified: false,
        sourceScopeComplete: false,
      },
    });

    const reloaded = await readStagingArtifacts(logDirectory, importId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.canonicalEvents[0]!.cloudAgentId).toBe(
      "bc-agent-full-private-id-001",
    );
    expect(JSON.stringify(reloaded!.publicSummary)).not.toContain(
      "bc-agent-full-private-id-001",
    );
  });
});
