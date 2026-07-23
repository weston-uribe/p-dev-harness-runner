/**
 * Map Cursor CSV / Admin API display model names to pricing-registry IDs.
 * Unknown models resolve to null → tokens-only (no list-price scores).
 */

export const MODEL_ALIAS_REGISTRY_VERSION = "1.0.0" as const;

/** Explicit alias map + known registry IDs that may pass through. */
const ALIAS_TO_REGISTRY_ID: Readonly<Record<string, string>> = {
  "composer-2.5": "composer-2.5",
  "composer 2.5": "composer-2.5",
  "composer2.5": "composer-2.5",
  "composer-2": "composer-2.5",
};

const KNOWN_REGISTRY_IDS = new Set(["composer-2.5"]);

export function normalizeModelRaw(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolve a source model string to a pricing-registry modelId, or null if unknown.
 * Does not invent aliases for unlisted display names (e.g. composer-2-fast).
 */
export function resolveCanonicalModelId(modelRaw: string): string | null {
  const key = normalizeModelRaw(modelRaw);
  if (!key) return null;
  if (ALIAS_TO_REGISTRY_ID[key]) {
    return ALIAS_TO_REGISTRY_ID[key]!;
  }
  if (KNOWN_REGISTRY_IDS.has(key)) {
    return key;
  }
  return null;
}
