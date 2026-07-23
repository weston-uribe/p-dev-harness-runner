/**
 * Private writer boundary: complete provider IDs may enter here solely to
 * compute public-safe hashes. Callers must not retain raw IDs on public
 * comment / footer / link input objects.
 */

import {
  assertCanonicalProviderIdentityHash,
  hashProviderIdentity,
} from "../identity/provider-identity-hash.js";

export interface PublicProviderIdentityHashes {
  cursorAgentIdHash?: string;
  cursorRunIdHash?: string;
  builderAgentIdHash?: string;
  previousBuilderAgentIdHash?: string;
}

export interface RawProviderIdentityInput {
  cursorAgentId?: string | null;
  cursorRunId?: string | null;
  builderAgentId?: string | null;
  previousBuilderAgentId?: string | null;
}

function hashOptional(id: string | null | undefined): string | undefined {
  const trimmed = id?.trim();
  if (!trimmed) {
    return undefined;
  }
  const hash = hashProviderIdentity(trimmed);
  assertCanonicalProviderIdentityHash(hash);
  return hash;
}

/**
 * Convert complete provider IDs into a hash-only public identity object.
 * Raw IDs are not retained on the returned object.
 */
export function toPublicProviderIdentityHashes(
  input: RawProviderIdentityInput,
): PublicProviderIdentityHashes {
  const out: PublicProviderIdentityHashes = {};
  const cursorAgentIdHash = hashOptional(input.cursorAgentId);
  const cursorRunIdHash = hashOptional(input.cursorRunId);
  const builderAgentIdHash = hashOptional(input.builderAgentId);
  const previousBuilderAgentIdHash = hashOptional(input.previousBuilderAgentId);
  if (cursorAgentIdHash) out.cursorAgentIdHash = cursorAgentIdHash;
  if (cursorRunIdHash) out.cursorRunIdHash = cursorRunIdHash;
  if (builderAgentIdHash) out.builderAgentIdHash = builderAgentIdHash;
  if (previousBuilderAgentIdHash) {
    out.previousBuilderAgentIdHash = previousBuilderAgentIdHash;
  }
  return out;
}
