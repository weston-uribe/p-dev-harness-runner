import { createHash } from "node:crypto";

export const LAUNCH_SURFACES_SCHEMA_KIND =
  "p-dev.cursor-cloud-agent-launch-surfaces.v1" as const;

export const PROVENANCE_WRITER_VERSION = "cursor-provenance-writer-v1" as const;

/**
 * Exhaustive live production Linear-harness launch surfaces.
 * Kept in sync with LinearHarnessAgentProvider surface union.
 */
export const PRODUCTION_LAUNCH_SURFACES = [
  "planning.create",
  "plan_review.create",
  "plan_review.resume",
  "implementation.initial_create",
  "implementation.resume",
  "implementation.replacement",
  "revision.resume",
  "revision.replacement",
  "code_review.create",
  "code_revision.create",
  "integration_repair.resume",
  "integration_repair.replacement",
] as const;

export type ProductionLaunchSurface =
  (typeof PRODUCTION_LAUNCH_SURFACES)[number];

export interface LaunchSurfacesManifest {
  kind: typeof LAUNCH_SURFACES_SCHEMA_KIND;
  version: "1";
  surfaces: readonly ProductionLaunchSurface[];
  writerVersion: typeof PROVENANCE_WRITER_VERSION;
}

export function getLaunchSurfacesManifest(): LaunchSurfacesManifest {
  return {
    kind: LAUNCH_SURFACES_SCHEMA_KIND,
    version: "1",
    surfaces: PRODUCTION_LAUNCH_SURFACES,
    writerVersion: PROVENANCE_WRITER_VERSION,
  };
}

export function launchSurfacesManifestDigest(
  manifest: LaunchSurfacesManifest = getLaunchSurfacesManifest(),
): string {
  const canonical = JSON.stringify({
    kind: manifest.kind,
    version: manifest.version,
    surfaces: [...manifest.surfaces].sort(),
    writerVersion: manifest.writerVersion,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function assertKnownLaunchSurface(
  surface: string,
): asserts surface is ProductionLaunchSurface {
  if (
    !(PRODUCTION_LAUNCH_SURFACES as readonly string[]).includes(surface)
  ) {
    throw new Error(
      `Unknown production launch surface: ${surface.slice(0, 64)}`,
    );
  }
}

/**
 * @deprecated Do not use for exhaustiveness proofs — alias of the same array.
 * Structural tests must independently enumerate call sites.
 */
export const PRODUCTION_WRAPPER_SURFACE_UNION: readonly ProductionLaunchSurface[] =
  PRODUCTION_LAUNCH_SURFACES;

/**
 * Live production send surfaces (agent.send via production wrapper).
 * Independently enumerated from launch surfaces for structural validation.
 */
export const PRODUCTION_SEND_SURFACES = [
  "planning.send",
  "planning.send.quality_repair",
  "plan_review.send",
  "implementation.send",
  "revision.send",
  "code_review.send",
  "code_revision.send",
  "integration_repair.send",
] as const;

export type ProductionSendSurface = (typeof PRODUCTION_SEND_SURFACES)[number];

export function getSendSurfacesManifest(): {
  kind: "p-dev.cursor-cloud-agent-send-surfaces.v1";
  version: "1";
  surfaces: readonly ProductionSendSurface[];
  writerVersion: typeof PROVENANCE_WRITER_VERSION;
} {
  return {
    kind: "p-dev.cursor-cloud-agent-send-surfaces.v1",
    version: "1",
    surfaces: PRODUCTION_SEND_SURFACES,
    writerVersion: PROVENANCE_WRITER_VERSION,
  };
}

export function sendSurfacesManifestDigest(): string {
  const manifest = getSendSurfacesManifest();
  const canonical = JSON.stringify({
    kind: manifest.kind,
    version: manifest.version,
    surfaces: [...manifest.surfaces].sort(),
    writerVersion: manifest.writerVersion,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
