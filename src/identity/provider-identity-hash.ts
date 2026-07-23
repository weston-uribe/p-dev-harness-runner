import { createHash } from "node:crypto";

/** Canonical provider-identity hash: SHA-256 hex, exactly 64 lowercase chars. */
export const CANONICAL_PROVIDER_IDENTITY_HASH_PATTERN = /^[0-9a-f]{64}$/;

export class ProviderIdentityHashError extends Error {
  readonly code = "invalid_provider_identity_hash" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderIdentityHashError";
  }
}

/**
 * Canonical SHA-256 hex digest of a complete provider identity string.
 * Always emits lowercase 64-character hex.
 */
export function hashProviderIdentity(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

/**
 * Fail-closed validation for public marker / lineage hash fields.
 * Rejects uppercase, mixed-case, short, long, and non-hex values.
 * Does not normalize.
 */
export function assertCanonicalProviderIdentityHash(
  value: string,
): asserts value is string {
  if (!CANONICAL_PROVIDER_IDENTITY_HASH_PATTERN.test(value)) {
    throw new ProviderIdentityHashError(
      `Provider identity hash must match ^[0-9a-f]{64}$ (got length ${value.length}).`,
    );
  }
}

export function isCanonicalProviderIdentityHash(value: string): boolean {
  return CANONICAL_PROVIDER_IDENTITY_HASH_PATTERN.test(value);
}
