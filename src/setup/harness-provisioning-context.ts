import { P_DEV_PACKAGE_NAME } from "../p-dev/package-paths.js";
import type { WorkspaceSnapshotManifest } from "../p-dev/workspace-snapshot-types.js";

export type HarnessProvisioningClassification =
  | "absent"
  | "valid-managed"
  | "public-collision"
  | "unmanaged-collision"
  | "malformed-marker"
  | "snapshot-only-without-pending"
  | "snapshot-only-with-pending";

export interface HarnessProvisioningPreviewContext {
  operationId: string;
  authenticatedUserId: number;
  authenticatedLogin: string;
  destination: string;
  packageName: string;
  packageVersion: string;
  sourceRepository: string;
  sourceCommit: string;
  manifestSchemaVersion: number;
  snapshotFingerprint: string;
  snapshotContentId: string;
  snapshotSha256: string;
  snapshotGitTreeSha1: string;
  classification: HarnessProvisioningClassification;
  envBaseline: string;
  pDevVersion: string;
  resumedFromPending: boolean;
  creationPreviewFingerprint: string | null;
}

export type HarnessProvisioningContextField =
  | "operationId"
  | "authenticatedUserId"
  | "authenticatedLogin"
  | "destination"
  | "packageName"
  | "packageVersion"
  | "sourceRepository"
  | "sourceCommit"
  | "manifestSchemaVersion"
  | "snapshotFingerprint"
  | "snapshotContentId"
  | "snapshotSha256"
  | "snapshotGitTreeSha1"
  | "classification"
  | "envBaseline"
  | "pDevVersion"
  | "resumedFromPending"
  | "creationPreviewFingerprint";

export type HarnessProvisioningContextComparisonResult =
  | { ok: true }
  | {
      ok: false;
      mismatchedField: HarnessProvisioningContextField;
      message: string;
    };

const CONTEXT_ACTION = "preview";

export function normalizeGitHubLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function normalizeRepoSlug(slug: string): string {
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator === -1) {
    return trimmed.toLowerCase();
  }
  const owner = trimmed.slice(0, separator);
  const repo = trimmed.slice(separator + 1);
  return `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
}

export function buildHarnessProvisioningPreviewContext(input: {
  operationId: string;
  user: { id: number; login: string };
  destination: string;
  manifest: WorkspaceSnapshotManifest;
  snapshotFingerprint: string;
  classification: HarnessProvisioningClassification;
  envBaseline: string;
  pDevVersion: string;
  resumedFromPending: boolean;
  creationPreviewFingerprint: string | null;
}): HarnessProvisioningPreviewContext {
  return {
    operationId: input.operationId,
    authenticatedUserId: input.user.id,
    authenticatedLogin: normalizeGitHubLogin(input.user.login),
    destination: normalizeRepoSlug(input.destination),
    packageName: input.manifest.packageName,
    packageVersion: input.manifest.packageVersion,
    sourceRepository: input.manifest.sourceRepository,
    sourceCommit: input.manifest.sourceCommit,
    manifestSchemaVersion: input.manifest.schemaVersion,
    snapshotFingerprint: input.snapshotFingerprint,
    snapshotContentId: input.manifest.snapshotContentId.trim(),
    snapshotSha256: input.manifest.snapshotSha256,
    snapshotGitTreeSha1: input.manifest.gitRootTreeSha1,
    classification: input.classification,
    envBaseline: normalizeRepoSlug(input.envBaseline || ""),
    pDevVersion: input.pDevVersion.trim(),
    resumedFromPending: input.resumedFromPending,
    creationPreviewFingerprint: input.creationPreviewFingerprint,
  };
}

export function serializeHarnessProvisioningPreviewContext(
  context: HarnessProvisioningPreviewContext,
): string {
  return JSON.stringify({
    action: CONTEXT_ACTION,
    operationId: context.operationId,
    authenticatedUserId: context.authenticatedUserId,
    authenticatedLogin: context.authenticatedLogin,
    destination: context.destination,
    packageName: context.packageName,
    packageVersion: context.packageVersion,
    sourceRepository: context.sourceRepository,
    sourceCommit: context.sourceCommit,
    manifestSchemaVersion: context.manifestSchemaVersion,
    snapshotFingerprint: context.snapshotFingerprint,
    snapshotContentId: context.snapshotContentId,
    snapshotSha256: context.snapshotSha256,
    snapshotGitTreeSha1: context.snapshotGitTreeSha1,
    classification: context.classification,
    envBaseline: context.envBaseline,
    pDevVersion: context.pDevVersion,
    resumedFromPending: context.resumedFromPending,
    creationPreviewFingerprint: context.creationPreviewFingerprint,
  });
}

export function parseHarnessProvisioningPreviewContextFingerprint(
  fingerprint: string,
): HarnessProvisioningPreviewContext | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fingerprint);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== CONTEXT_ACTION) {
    return null;
  }
  if (typeof record.operationId !== "string" || !record.operationId.trim()) {
    return null;
  }
  if (
    typeof record.authenticatedUserId !== "number" ||
    !Number.isFinite(record.authenticatedUserId)
  ) {
    return null;
  }
  if (
    typeof record.authenticatedLogin !== "string" ||
    !record.authenticatedLogin.trim()
  ) {
    return null;
  }
  if (typeof record.destination !== "string") {
    return null;
  }
  if (record.packageName !== P_DEV_PACKAGE_NAME) {
    return null;
  }
  if (
    typeof record.packageVersion !== "string" ||
    typeof record.sourceRepository !== "string" ||
    typeof record.sourceCommit !== "string" ||
    typeof record.manifestSchemaVersion !== "number" ||
    typeof record.snapshotFingerprint !== "string" ||
    typeof record.snapshotContentId !== "string" ||
    typeof record.snapshotSha256 !== "string" ||
    typeof record.snapshotGitTreeSha1 !== "string" ||
    typeof record.classification !== "string" ||
    typeof record.envBaseline !== "string" ||
    typeof record.pDevVersion !== "string" ||
    typeof record.resumedFromPending !== "boolean"
  ) {
    return null;
  }
  if (
    record.creationPreviewFingerprint !== null &&
    typeof record.creationPreviewFingerprint !== "string"
  ) {
    return null;
  }

  return {
    operationId: record.operationId.trim(),
    authenticatedUserId: record.authenticatedUserId,
    authenticatedLogin: normalizeGitHubLogin(record.authenticatedLogin),
    destination: normalizeRepoSlug(record.destination),
    packageName: P_DEV_PACKAGE_NAME,
    packageVersion: String(record.packageVersion).trim(),
    sourceRepository: String(record.sourceRepository),
    sourceCommit: String(record.sourceCommit),
    manifestSchemaVersion: record.manifestSchemaVersion,
    snapshotFingerprint: String(record.snapshotFingerprint),
    snapshotContentId: String(record.snapshotContentId).trim(),
    snapshotSha256: String(record.snapshotSha256),
    snapshotGitTreeSha1: String(record.snapshotGitTreeSha1),
    classification: record.classification as HarnessProvisioningClassification,
    envBaseline: normalizeRepoSlug(String(record.envBaseline)),
    pDevVersion: String(record.pDevVersion).trim(),
    resumedFromPending: record.resumedFromPending,
    creationPreviewFingerprint:
      record.creationPreviewFingerprint === null
        ? null
        : String(record.creationPreviewFingerprint),
  };
}

function compareField(
  field: HarnessProvisioningContextField,
  submitted: unknown,
  current: unknown,
): HarnessProvisioningContextComparisonResult | null {
  if (submitted !== current) {
    return {
      ok: false,
      mismatchedField: field,
      message: `Provisioning preview is stale (${field} changed). Retry Step 1 Continue.`,
    };
  }
  return null;
}

export function compareHarnessProvisioningPreviewContexts(
  submitted: HarnessProvisioningPreviewContext,
  current: HarnessProvisioningPreviewContext,
): HarnessProvisioningContextComparisonResult {
  const checks: Array<
    [HarnessProvisioningContextField, unknown, unknown]
  > = [
    ["operationId", submitted.operationId, current.operationId],
    [
      "authenticatedUserId",
      submitted.authenticatedUserId,
      current.authenticatedUserId,
    ],
    [
      "authenticatedLogin",
      submitted.authenticatedLogin,
      current.authenticatedLogin,
    ],
    ["destination", submitted.destination, current.destination],
    ["packageName", submitted.packageName, current.packageName],
    ["packageVersion", submitted.packageVersion, current.packageVersion],
    ["sourceRepository", submitted.sourceRepository, current.sourceRepository],
    ["sourceCommit", submitted.sourceCommit, current.sourceCommit],
    [
      "manifestSchemaVersion",
      submitted.manifestSchemaVersion,
      current.manifestSchemaVersion,
    ],
    [
      "snapshotFingerprint",
      submitted.snapshotFingerprint,
      current.snapshotFingerprint,
    ],
    ["snapshotContentId", submitted.snapshotContentId, current.snapshotContentId],
    ["snapshotSha256", submitted.snapshotSha256, current.snapshotSha256],
    [
      "snapshotGitTreeSha1",
      submitted.snapshotGitTreeSha1,
      current.snapshotGitTreeSha1,
    ],
    ["classification", submitted.classification, current.classification],
    ["envBaseline", submitted.envBaseline, current.envBaseline],
    ["pDevVersion", submitted.pDevVersion, current.pDevVersion],
    [
      "resumedFromPending",
      submitted.resumedFromPending,
      current.resumedFromPending,
    ],
    [
      "creationPreviewFingerprint",
      submitted.creationPreviewFingerprint,
      current.creationPreviewFingerprint,
    ],
  ];

  for (const [field, left, right] of checks) {
    const mismatch = compareField(field, left, right);
    if (mismatch) {
      return mismatch;
    }
  }

  return { ok: true };
}

export function validateSubmittedHarnessProvisioningFingerprint(input: {
  submittedFingerprint: string;
  currentContext: HarnessProvisioningPreviewContext;
}): HarnessProvisioningContextComparisonResult {
  const submitted = parseHarnessProvisioningPreviewContextFingerprint(
    input.submittedFingerprint,
  );
  if (!submitted) {
    return {
      ok: false,
      mismatchedField: "operationId",
      message:
        "Provisioning preview fingerprint is invalid. Retry Step 1 Continue.",
    };
  }
  return compareHarnessProvisioningPreviewContexts(
    submitted,
    input.currentContext,
  );
}

/** Test-only helper for field-level diagnostics without exposing secrets. */
export function diagnoseHarnessProvisioningFingerprintMismatch(input: {
  submittedFingerprint: string;
  currentContext: HarnessProvisioningPreviewContext;
}): HarnessProvisioningContextComparisonResult {
  return validateSubmittedHarnessProvisioningFingerprint(input);
}
