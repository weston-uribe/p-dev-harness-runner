import { createHash } from "node:crypto";
import { digestCanonical } from "../expected-score-manifest.js";
import { CURSOR_USAGE_IMPORTER_VERSION } from "../types.js";
import { PARSER_SCHEMA_VERSION } from "../parse.js";
import { CANONICAL_USAGE_SCHEMA_VERSION } from "../canonical.js";

export const DISPOSITION_MANIFEST_VERSION = "1" as const;

export type DispositionKind = "historical_scope_unrecoverable" | "operator_excluded";

export interface DispositionPublicSafeCounts {
  sourceRowCount: number;
  cloudAgentAttributableRowCount: number;
  tokenBearingRowCount: number;
  bundleCount: number;
}

export interface DispositionEntry {
  canonicalSourceDigestSha256: string;
  canonicalImportIdentity: string | null;
  dispositionKind: DispositionKind;
  reasonCode: string;
  evidenceDigest: string;
  importerVersion: string;
  parserSchemaVersion: number;
  canonicalUsageSchemaVersion: number;
  originalImportId: string | null;
  originalPreflightId: string | null;
  originalPublicSafeCounts: DispositionPublicSafeCounts;
  recordedAt: string;
  manifestVersion: typeof DISPOSITION_MANIFEST_VERSION;
}

export interface DispositionManifest {
  manifestVersion: typeof DISPOSITION_MANIFEST_VERSION;
  entries: DispositionEntry[];
  manifestDigest: string;
}

export const HISTORICAL_UNRECOVERABLE_SOURCE_DIGEST =
  "6ae495cf73d288a26df8a8e21db22c7cc60b29809525b179f18e4f2d5d19f783" as const;

/**
 * Known preflight public-safe counts for the historical unrecoverable CSV.
 * Placeholder ledger values — digest is authoritative; counts preserved for audit.
 */
const HISTORICAL_PUBLIC_SAFE_COUNTS: DispositionPublicSafeCounts = {
  sourceRowCount: 845,
  cloudAgentAttributableRowCount: 205,
  tokenBearingRowCount: 845,
  bundleCount: 65,
};

function entryEvidenceDigest(entry: Omit<DispositionEntry, "evidenceDigest">): string {
  return createHash("sha256")
    .update(
      digestCanonical({
        canonicalSourceDigestSha256: entry.canonicalSourceDigestSha256,
        dispositionKind: entry.dispositionKind,
        reasonCode: entry.reasonCode,
        originalPublicSafeCounts: entry.originalPublicSafeCounts,
        recordedAt: entry.recordedAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function buildDispositionEntry(
  partial: Omit<DispositionEntry, "evidenceDigest" | "manifestVersion">,
): DispositionEntry {
  const base = {
    ...partial,
    manifestVersion: DISPOSITION_MANIFEST_VERSION,
  };
  return {
    ...base,
    evidenceDigest: entryEvidenceDigest(base),
  };
}

export function buildDefaultDispositionManifest(
  _now?: string,
): DispositionManifest {
  const entries: DispositionEntry[] = [
    buildDispositionEntry({
      canonicalSourceDigestSha256: HISTORICAL_UNRECOVERABLE_SOURCE_DIGEST,
      canonicalImportIdentity: null,
      dispositionKind: "historical_scope_unrecoverable",
      reasonCode: "pre_pdev_sealed_coverage_registry",
      importerVersion: CURSOR_USAGE_IMPORTER_VERSION,
      parserSchemaVersion: PARSER_SCHEMA_VERSION,
      canonicalUsageSchemaVersion: CANONICAL_USAGE_SCHEMA_VERSION,
      originalImportId: "476bca87-4fc8-4bd8-b230-76418efd3e27",
      originalPreflightId: "476bca87-4fc8-4bd8-b230-76418efd3e27",
      originalPublicSafeCounts: HISTORICAL_PUBLIC_SAFE_COUNTS,
      recordedAt: "2026-07-22T23:15:20.564Z",
    }),
  ];

  const partial = {
    manifestVersion: DISPOSITION_MANIFEST_VERSION,
    entries: [...entries].sort((a, b) =>
      a.canonicalSourceDigestSha256.localeCompare(b.canonicalSourceDigestSha256),
    ),
  };

  return {
    ...partial,
    manifestDigest: digestCanonical(partial),
  };
}

export type DispositionCheckResult =
  | { ok: true; entry: null }
  | { ok: true; entry: DispositionEntry; applyBlocked: false }
  | { ok: false; code: string; detail: string; entry?: DispositionEntry };

export function checkSourceDisposition(input: {
  sourceDigestSha256: string;
  manifest?: DispositionManifest;
}): DispositionCheckResult {
  const manifest = input.manifest ?? buildDefaultDispositionManifest();
  const matches = manifest.entries.filter(
    (entry) => entry.canonicalSourceDigestSha256 === input.sourceDigestSha256,
  );

  if (matches.length === 0) {
    return { ok: true, entry: null };
  }

  if (matches.length > 1) {
    const kinds = new Set(matches.map((m) => m.dispositionKind));
    if (kinds.size > 1) {
      return {
        ok: false,
        code: "disposition_conflict",
        detail: `conflicting dispositions for digest ${input.sourceDigestSha256}`,
      };
    }
  }

  const entry = matches[0]!;
  if (entry.dispositionKind === "historical_scope_unrecoverable") {
    return {
      ok: false,
      code: "historical_scope_unrecoverable",
      detail: entry.reasonCode,
      entry,
    };
  }

  return { ok: true, entry, applyBlocked: false };
}

export function dispositionManifestDigest(
  manifest: DispositionManifest = buildDefaultDispositionManifest(),
): string {
  return manifest.manifestDigest;
}
