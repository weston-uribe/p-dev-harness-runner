import type { ProductionLaunchSurface } from "./launch-surfaces.js";
import { PRODUCTION_LAUNCH_SURFACES } from "./launch-surfaces.js";

/** Harness phases that may launch production Cursor cloud agents. */
export type ProductionLaunchPhase =
  | "planning"
  | "plan_review"
  | "implementation"
  | "revision"
  | "code_review"
  | "code_revision"
  | "integration_repair";

export type ProductionLaunchAction = "create" | "resume" | "replacement";

export interface ProductionLaunchMappingEntry {
  phase: ProductionLaunchPhase;
  action: ProductionLaunchAction;
  surface: ProductionLaunchSurface;
}

/**
 * Exhaustive mapping from phase + action to canonical production launch surfaces.
 * Every {@link PRODUCTION_LAUNCH_SURFACES} entry appears exactly once.
 */
export const PRODUCTION_LAUNCH_MAPPING: readonly ProductionLaunchMappingEntry[] =
  [
    { phase: "planning", action: "create", surface: "planning.create" },
    { phase: "plan_review", action: "create", surface: "plan_review.create" },
    { phase: "plan_review", action: "resume", surface: "plan_review.resume" },
    {
      phase: "implementation",
      action: "create",
      surface: "implementation.initial_create",
    },
    {
      phase: "implementation",
      action: "resume",
      surface: "implementation.resume",
    },
    {
      phase: "implementation",
      action: "replacement",
      surface: "implementation.replacement",
    },
    { phase: "revision", action: "resume", surface: "revision.resume" },
    {
      phase: "revision",
      action: "replacement",
      surface: "revision.replacement",
    },
    { phase: "code_review", action: "create", surface: "code_review.create" },
    {
      phase: "code_revision",
      action: "create",
      surface: "code_revision.create",
    },
    {
      phase: "integration_repair",
      action: "resume",
      surface: "integration_repair.resume",
    },
    {
      phase: "integration_repair",
      action: "replacement",
      surface: "integration_repair.replacement",
    },
  ] as const;

const mappingByKey = new Map<string, ProductionLaunchSurface>(
  PRODUCTION_LAUNCH_MAPPING.map((row) => [
    `${row.phase}:${row.action}`,
    row.surface,
  ]),
);

export interface ResolveProductionLaunchSurfaceOpts {
  /**
   * Reserved for generation-sensitive surfaces. Implementation `create` always
   * maps to `implementation.initial_create` regardless of generation.
   */
  generation?: number;
}

export function resolveProductionLaunchSurface(
  phase: ProductionLaunchPhase,
  action: ProductionLaunchAction,
  _opts?: ResolveProductionLaunchSurfaceOpts,
): ProductionLaunchSurface {
  const surface = mappingByKey.get(`${phase}:${action}`);
  if (!surface) {
    throw new Error(
      `Invalid production launch mapping: phase=${phase} action=${action}`,
    );
  }
  return surface;
}

export function allMappedLaunchSurfaces(): ProductionLaunchSurface[] {
  return [...new Set(PRODUCTION_LAUNCH_MAPPING.map((row) => row.surface))].sort();
}

/** Structural-test helper: valid actions for a builder phase discovered via AST. */
export function validActionsForLaunchPhase(
  phase: ProductionLaunchPhase,
): ProductionLaunchAction[] {
  const actions = PRODUCTION_LAUNCH_MAPPING.filter((row) => row.phase === phase).map(
    (row) => row.action,
  );
  return [...new Set(actions)];
}

if (allMappedLaunchSurfaces().length !== PRODUCTION_LAUNCH_SURFACES.length) {
  throw new Error(
    "PRODUCTION_LAUNCH_MAPPING must cover every PRODUCTION_LAUNCH_SURFACES entry exactly once",
  );
}

for (const surface of PRODUCTION_LAUNCH_SURFACES) {
  const matches = PRODUCTION_LAUNCH_MAPPING.filter((row) => row.surface === surface);
  if (matches.length !== 1) {
    throw new Error(
      `PRODUCTION_LAUNCH_MAPPING must include ${surface} exactly once (found ${matches.length})`,
    );
  }
}
