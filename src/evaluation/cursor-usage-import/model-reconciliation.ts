import type { PricingVariant } from "../telemetry/pricing-registry.js";
import {
  MODEL_ALIAS_REGISTRY_VERSION,
  normalizeModelRaw,
  resolveCanonicalModelId,
} from "./model-aliases.js";
import type { ObservedModelEvidence } from "./types.js";

export const MODEL_RECONCILIATION_CONTRACT_VERSION = "1.0.0" as const;

export type ModelReconciliationOutcome =
  | "compatible"
  | "explicitly_proven_multi_model_execution"
  | "source_model_unknown"
  | "candidate_model_unknown"
  | "model_identity_conflict"
  | "source_variant_unknown"
  | "variant_identity_conflict";

export interface ModelReconciliationResult {
  outcome: ModelReconciliationOutcome;
  tokensAllowed: boolean;
  costAllowed: boolean;
  matchedObserved: ObservedModelEvidence | null;
  reason: string;
}

export interface ReconcileModelParams {
  sourceModelRaw: string;
  sourceModelCanonical: string | null;
  observedModels: ObservedModelEvidence[];
  multiModelExecutionProven: boolean;
  sourceVariantHint?: PricingVariant | "unknown" | null;
  candidateVariant: PricingVariant | null;
}

/**
 * Collapse an observation to a single identity key.
 * - Canonical (or alias-resolvable) models share identity by canonical ID.
 * - Unresolved normalized raws share identity only by exact normalized raw.
 * Multiple raw aliases of the same canonical are one identity.
 */
export function observedModelIdentityKey(o: ObservedModelEvidence): string {
  const canonical =
    o.canonicalModelId ??
    resolveCanonicalModelId(o.rawModel) ??
    resolveCanonicalModelId(o.normalizedRawModel);
  if (canonical != null) {
    return `canonical:${canonical}`;
  }
  return `unresolved:${o.normalizedRawModel}`;
}

/**
 * Distinct observed model identities after alias-aware collapse.
 * Do not use raw-string cardinality alone — aliases of one canonical are one identity.
 */
export function distinctObservedIdentities(
  observed: ObservedModelEvidence[],
): Set<string> {
  return new Set(observed.map(observedModelIdentityKey));
}

/**
 * Never treat two null canonical IDs as compatible merely because both are unknown.
 * Raw fallback requires exact normalizedRawModel equality and permits tokens only.
 */
export function reconcileSourceModel(
  params: ReconcileModelParams,
): ModelReconciliationResult {
  const sourceCanonical =
    params.sourceModelCanonical ?? resolveCanonicalModelId(params.sourceModelRaw);
  const sourceNormalized = normalizeModelRaw(params.sourceModelRaw);
  const observed = params.observedModels;

  if (observed.length === 0) {
    // Explicit policy: when Langfuse observations carry no model provenance,
    // allow tokens-only attribution; never authorize calculated USD from this path.
    return {
      outcome: "candidate_model_unknown",
      tokensAllowed: true,
      costAllowed: false,
      matchedObserved: null,
      reason: "no_observed_models_tokens_only",
    };
  }

  const identities = distinctObservedIdentities(observed);
  const contradictory = identities.size > 1;

  // Without proof, any genuinely contradictory set fails closed — even if the
  // source matches one member. No match escape hatch.
  if (contradictory && !params.multiModelExecutionProven) {
    return {
      outcome: "model_identity_conflict",
      tokensAllowed: false,
      costAllowed: false,
      matchedObserved: null,
      reason: "unproven_multi_model_observations",
    };
  }

  const match = findObservedMatch({
    sourceCanonical,
    sourceNormalized,
    observed,
  });

  if (!match) {
    if (sourceCanonical == null) {
      return {
        outcome: "source_model_unknown",
        tokensAllowed: false,
        costAllowed: false,
        matchedObserved: null,
        reason: "source_unknown_no_raw_match",
      };
    }
    if (
      params.multiModelExecutionProven &&
      !observed.some((o) => {
        const key = observedModelIdentityKey(o);
        const sourceKey =
          sourceCanonical != null
            ? `canonical:${sourceCanonical}`
            : `unresolved:${sourceNormalized}`;
        return (
          key === sourceKey ||
          o.normalizedRawModel === sourceNormalized ||
          (sourceCanonical != null &&
            (o.canonicalModelId === sourceCanonical ||
              resolveCanonicalModelId(o.rawModel) === sourceCanonical))
        );
      })
    ) {
      return {
        outcome: "model_identity_conflict",
        tokensAllowed: false,
        costAllowed: false,
        matchedObserved: null,
        reason: "multi_model_flag_cannot_authorize_unobserved_model",
      };
    }
    return {
      outcome: "model_identity_conflict",
      tokensAllowed: false,
      costAllowed: false,
      matchedObserved: null,
      reason: "source_not_in_observed_set",
    };
  }

  const multiProven = params.multiModelExecutionProven && contradictory;

  // Variant checks
  const candidateVariant = params.candidateVariant;
  const observedVariant = match.variant;
  if (candidateVariant == null) {
    return {
      outcome: "source_variant_unknown",
      tokensAllowed: true,
      costAllowed: false,
      matchedObserved: match,
      reason: "candidate_variant_missing",
    };
  }
  if (observedVariant === "unknown") {
    return {
      outcome: "source_variant_unknown",
      tokensAllowed: true,
      costAllowed: false,
      matchedObserved: match,
      reason: "observed_variant_unknown",
    };
  }
  if (observedVariant !== candidateVariant) {
    return {
      outcome: "variant_identity_conflict",
      tokensAllowed: false,
      costAllowed: false,
      matchedObserved: match,
      reason: "variant_mismatch",
    };
  }

  // Raw-only match (null canonicals equal by normalized raw): tokens only.
  if (sourceCanonical == null || match.canonicalModelId == null) {
    const matchCanonical =
      match.canonicalModelId ?? resolveCanonicalModelId(match.rawModel);
    if (sourceCanonical == null && matchCanonical == null) {
      if (match.normalizedRawModel !== sourceNormalized) {
        return {
          outcome: "model_identity_conflict",
          tokensAllowed: false,
          costAllowed: false,
          matchedObserved: null,
          reason: "unknown_raw_mismatch",
        };
      }
      return {
        outcome: "source_model_unknown",
        tokensAllowed: true,
        costAllowed: false,
        matchedObserved: match,
        reason: "unknown_raw_fallback_tokens_only",
      };
    }
  }

  return {
    outcome: multiProven
      ? "explicitly_proven_multi_model_execution"
      : "compatible",
    tokensAllowed: true,
    costAllowed: true,
    matchedObserved: match,
    reason: multiProven ? "proven_multi_model" : "canonical_match",
  };
}

function findObservedMatch(params: {
  sourceCanonical: string | null;
  sourceNormalized: string;
  observed: ObservedModelEvidence[];
}): ObservedModelEvidence | null {
  if (params.sourceCanonical) {
    const byCanonical = params.observed.find((o) => {
      const canonical =
        o.canonicalModelId ??
        resolveCanonicalModelId(o.rawModel) ??
        resolveCanonicalModelId(o.normalizedRawModel);
      return canonical === params.sourceCanonical;
    });
    if (byCanonical) return byCanonical;
  }
  // Raw fallback: exact normalized equality only.
  const byRaw = params.observed.filter(
    (o) => o.normalizedRawModel === params.sourceNormalized,
  );
  if (byRaw.length >= 1) return byRaw[0]!;
  return null;
}

export { MODEL_ALIAS_REGISTRY_VERSION };
