/**
 * Cursor execution-surface capability for native Agent Skills.
 *
 * Taxonomy:
 * - supported — direct contract or provider evidence
 * - unsupported — explicit provider/API evidence that the capability is unavailable
 * - unproven — no sufficient evidence either way
 * - unavailable_in_environment — required executable/environment absent; could not be tested
 *
 * Do not mark a surface unsupported merely because a binary is missing from this machine.
 * Do not promote sdk_cloud_agent to supported without a real canary.
 */

import { spawnSync } from "node:child_process";
import type {
  CursorExecutionSurface,
  NativeSkillCapabilityState,
} from "../prompts/contracts.js";

export const NATIVE_SKILL_CAPABILITY_REGISTRY_VERSION = "2026-07-18.v2" as const;

export interface NativeSkillSurfaceCapability {
  surface: CursorExecutionSurface;
  state: NativeSkillCapabilityState;
  evidence: string;
  notes: string;
}

/** Test seam for PATH/CLI availability probes. */
let cursorCliAvailabilityProbe: (() => boolean) | null = null;

/** @internal — tests only */
export function setCursorCliAvailabilityProbeForTests(
  probe: (() => boolean) | null,
): void {
  cursorCliAvailabilityProbe = probe;
}

/** True when a `cursor` CLI executable is resolvable on PATH. */
export function isCursorCliAvailableInEnvironment(): boolean {
  if (cursorCliAvailabilityProbe) {
    return cursorCliAvailabilityProbe();
  }
  const probe = spawnSync("cursor", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  // ENOENT / not found → unavailable; other failures still mean the binary exists.
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    return code !== "ENOENT";
  }
  return probe.status === 0 || probe.status === 1;
}

function cursorCliSurfaceState(): NativeSkillCapabilityState {
  return isCursorCliAvailableInEnvironment()
    ? "unproven"
    : "unavailable_in_environment";
}

function cursorCliEvidence(): string {
  if (!isCursorCliAvailableInEnvironment()) {
    return "Cursor CLI executable (`cursor`) is not available in this environment (PATH probe failed with ENOENT or equivalent), so CLI skill behavior could not be tested. Absence of the binary must not be read as proof that CLI skills are unsupported.";
  }
  return "Cursor CLI is present in this environment, but no installed contract or provider evidence proves or disproves native Agent Skill discovery/invocation for interactive or non-interactive CLI modes. @cursor/sdk skill fields are unrelated to the CLI surface.";
}

/**
 * Production Cloud Agents must treat native skills as unproven.
 * Explicit SDK skill parameters remain absent from @cursor/sdk@1.0.23 create/send
 * types; ambient discovery is still unproven pending canary.
 */
export const NATIVE_SKILL_SURFACE_CAPABILITIES: readonly NativeSkillSurfaceCapability[] =
  [
    {
      surface: "cursor_editor",
      state: "unproven",
      evidence:
        "No editor types in @cursor/sdk for this harness integration. Repo docs describe operator-invoked SKILL.md packages under .agents/skills; that is not direct harness/provider proof of native skill invocation for automation.",
      notes:
        "Editor remains unproven for harness Cloud Agent integration unless direct evidence exists.",
    },
    {
      surface: "cursor_cli_interactive",
      state: cursorCliSurfaceState(),
      evidence: cursorCliEvidence(),
      notes:
        "Do not classify as unsupported solely because the CLI binary is absent from this environment.",
    },
    {
      surface: "cursor_cli_non_interactive",
      state: cursorCliSurfaceState(),
      evidence: cursorCliEvidence(),
      notes:
        "Do not classify as unsupported solely because the CLI binary is absent from this environment.",
    },
    {
      surface: "sdk_local_agent",
      state: "unproven",
      evidence:
        "Installed @cursor/sdk@1.0.23 has no skill fields on AgentOptions/SendOptions. Related fields (settingSources, customTools, customSubagents) are not named skills. Absence of an explicit skill parameter does not prove ambient project skill discovery is impossible for local agents; harness does not currently use local agents.",
      notes:
        "Explicit skill-parameter API is absent; ambient discovery remains unproven.",
    },
    {
      surface: "sdk_cloud_agent",
      state: "unproven",
      evidence:
        "V1CreateAgentRequest has prompt/model/mcpServers/customSubagents/repos — no skill field. Chunk 7 live canary against weston-uribe/pdev-native-skill-canary classified both candidate layouts (agents_skills, cursor_skills) as unavailable from provider evidence (no marker, no skill invoke events). Ambient discovery remains unproven — not promoted to unsupported. Production must use rendered_into_prompt.",
      notes:
        "Production must use rendered_into_prompt. Do not mark supported without direct canary evidence.",
    },
    {
      surface: "background_agent",
      state: "unproven",
      evidence:
        "No dedicated BackgroundAgent skill contract was found in @cursor/sdk@1.0.23. TaskSuccess.isBackground is subagent/task telemetry, not an explicit ruling that native skills are unavailable on background runs.",
      notes:
        "Mark unsupported only if a contract explicitly rules skills out; until then unproven.",
    },
  ] as const;

export function getNativeSkillCapability(
  surface: CursorExecutionSurface,
): NativeSkillSurfaceCapability {
  // Recompute CLI surfaces so PATH changes are reflected (tests may stub the probe).
  if (
    surface === "cursor_cli_interactive" ||
    surface === "cursor_cli_non_interactive"
  ) {
    return {
      surface,
      state: cursorCliSurfaceState(),
      evidence: cursorCliEvidence(),
      notes:
        "Do not classify as unsupported solely because the CLI binary is absent from this environment.",
    };
  }
  const found = NATIVE_SKILL_SURFACE_CAPABILITIES.find(
    (c) => c.surface === surface,
  );
  if (!found) {
    return {
      surface,
      state: "unproven",
      evidence: "Surface not listed in capability registry.",
      notes: "Default to unproven.",
    };
  }
  return found;
}

/** Production Cloud Agent path used by the harness runner. */
export function productionNativeSkillCapability(): NativeSkillCapabilityState {
  return getNativeSkillCapability("sdk_cloud_agent").state;
}

/**
 * Whether production may attempt native skill invocation.
 * Only `supported` enables native attempts; unproven, unsupported, and
 * unavailable_in_environment all forbid production native attempts.
 */
export function mayAttemptNativeSkillInProduction(
  surface: CursorExecutionSurface = "sdk_cloud_agent",
): boolean {
  return getNativeSkillCapability(surface).state === "supported";
}

/** Candidate layouts for disposable canary fixtures only — not production. */
export const NATIVE_SKILL_CANARY_CANDIDATE_LAYOUTS = [
  ".agents/skills/<skillId>/SKILL.md",
  ".cursor/skills/<skillId>/SKILL.md",
] as const;
