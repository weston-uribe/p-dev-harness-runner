/**
 * Template provenance contract for packaged p-dev harness repo provisioning.
 *
 * External prerequisite (operator-owned, not created by automation):
 * - Public GitHub template repo `weston-uribe/p-dev-harness-template` must exist,
 *   be marked `is_template: true`, and include `.harness/p-dev-template.json`.
 * - Real-account validation is blocked until that prerequisite is complete.
 */

export const HARNESS_TEMPLATE_OWNER = "weston-uribe";
export const HARNESS_TEMPLATE_REPO = "p-dev-harness-template";
export const HARNESS_TEMPLATE_SLUG = `${HARNESS_TEMPLATE_OWNER}/${HARNESS_TEMPLATE_REPO}`;

export const HARNESS_DEFAULT_DESTINATION_REPO_NAME = "p-dev-harness";
export const HARNESS_DEFAULT_DESTINATION_DESCRIPTION =
  "Private p-dev Product Development Harness workspace";

export const HARNESS_TEMPLATE_IDENTITY_FILE = ".harness/p-dev-template.json";
export const HARNESS_MANAGED_REPO_MARKER_FILE = ".harness/p-dev-managed-repo.json";

export const HARNESS_TEMPLATE_IDENTITY = "p-dev-harness-template";
export const HARNESS_PRODUCT = "p-dev";
export const HARNESS_TEMPLATE_ROLE = "harness-template";
export const HARNESS_WORKSPACE_ROLE = "harness-workspace";

export const HARNESS_SCHEMA_VERSION = 1;
export const HARNESS_COMPATIBILITY_VERSION = 1;
export const HARNESS_MARKER_VERSION = 1;

/** Legacy public source repo — not a valid packaged managed destination. */
export const HARNESS_LEGACY_PUBLIC_SOURCE_REPO =
  "weston-uribe/agentic-product-development-harness";

export interface HarnessTemplateIdentity {
  schemaVersion: number;
  product: string;
  role: string;
  templateIdentity: string;
  templateVersion: number;
  compatibilityVersion: number;
  templateContentId: string;
  source?: {
    repository?: string;
    release?: string;
    packageVersion?: string;
  };
}

export type HarnessTemplateIdentityValidationResult =
  | { ok: true; identity: HarnessTemplateIdentity }
  | { ok: false; reason: string };

export function parseHarnessTemplateIdentityJson(
  raw: string,
): HarnessTemplateIdentityValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "Template identity JSON is malformed." };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "Template identity JSON is malformed." };
  }

  const record = parsed as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  const product = record.product;
  const role = record.role;
  const templateIdentity = record.templateIdentity;
  const templateVersion = record.templateVersion;
  const compatibilityVersion = record.compatibilityVersion;
  const templateContentId = record.templateContentId;

  if (schemaVersion !== HARNESS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `Unsupported template schema version ${String(schemaVersion)}.`,
    };
  }
  if (product !== HARNESS_PRODUCT) {
    return {
      ok: false,
      reason: `Unexpected template product ${String(product)}.`,
    };
  }
  if (role !== HARNESS_TEMPLATE_ROLE) {
    return {
      ok: false,
      reason: `Unexpected template role ${String(role)}.`,
    };
  }
  if (templateIdentity !== HARNESS_TEMPLATE_IDENTITY) {
    return {
      ok: false,
      reason: `Unexpected template identity ${String(templateIdentity)}.`,
    };
  }
  if (templateVersion !== HARNESS_MARKER_VERSION) {
    return {
      ok: false,
      reason: `Unsupported template version ${String(templateVersion)}.`,
    };
  }
  if (compatibilityVersion !== HARNESS_COMPATIBILITY_VERSION) {
    return {
      ok: false,
      reason: `Incompatible template compatibility version ${String(compatibilityVersion)}.`,
    };
  }
  if (typeof templateContentId !== "string" || !templateContentId.trim()) {
    return {
      ok: false,
      reason: "Template identity is missing templateContentId.",
    };
  }

  const source =
    record.source && typeof record.source === "object"
      ? (record.source as HarnessTemplateIdentity["source"])
      : undefined;

  return {
    ok: true,
    identity: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      product: HARNESS_PRODUCT,
      role: HARNESS_TEMPLATE_ROLE,
      templateIdentity: HARNESS_TEMPLATE_IDENTITY,
      templateVersion: HARNESS_MARKER_VERSION,
      compatibilityVersion: HARNESS_COMPATIBILITY_VERSION,
      templateContentId: templateContentId.trim(),
      source,
    },
  };
}

export function fingerprintHarnessTemplateIdentity(
  identity: HarnessTemplateIdentity,
): string {
  return JSON.stringify({
    schemaVersion: identity.schemaVersion,
    product: identity.product,
    role: identity.role,
    templateIdentity: identity.templateIdentity,
    templateVersion: identity.templateVersion,
    compatibilityVersion: identity.compatibilityVersion,
    templateContentId: identity.templateContentId,
  });
}
