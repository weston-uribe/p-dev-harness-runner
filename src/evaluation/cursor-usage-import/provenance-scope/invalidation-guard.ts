import type { EpochInvalidationRecord } from "../../../provenance/coverage-lifecycle-schemas.js";
import type { RegistryReadResult } from "./contracts.js";

export interface EpochStagingGuardResult {
  blocked: boolean;
  reasonCode: string | null;
  invalidation: EpochInvalidationRecord | null;
}

export function assertEpochNotInvalidatedBeforeStaging(input: {
  epochId: string | null;
  invalidation: EpochInvalidationRecord | null;
}): EpochStagingGuardResult {
  if (!input.epochId || !input.invalidation) {
    return {
      blocked: false,
      reasonCode: null,
      invalidation: null,
    };
  }
  if (input.invalidation.epochId !== input.epochId) {
    return {
      blocked: false,
      reasonCode: null,
      invalidation: null,
    };
  }
  return {
    blocked: true,
    reasonCode: "epoch_invalidated_before_staging",
    invalidation: input.invalidation,
  };
}

export function registryEpochInvalidated(
  registry: RegistryReadResult | null,
): boolean {
  return registry?.epochInvalidated === true;
}

export function blockedReasonForInvalidatedRegistry(
  registry: RegistryReadResult | null,
): string | null {
  if (!registry?.epochInvalidated) return null;
  return registry.integrityFailures.find((f) => f.code === "epoch_invalidated")
    ?.code ?? "epoch_invalidated";
}
