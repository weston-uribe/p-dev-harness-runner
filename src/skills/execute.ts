/**
 * Skill execution policy for harness Cloud Agent phases.
 * Production: rendered_into_prompt from .agents/skills only.
 * Native remains unproven — never dual-inject; never claim discovered/invoked.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  inclusionMethodForInvocation,
  type PreferredSkillMode,
  type SkillExecutionRequest,
  type SkillExecutionResult,
} from "../prompts/contracts.js";
import {
  mayAttemptNativeSkillInProduction,
  productionNativeSkillCapability,
} from "./capability.js";
import { CANONICAL_SKILLS_DIR, contentSha256Of } from "./package.js";

export interface ExecuteSkillsParams {
  requests: Array<{
    skillId: string;
    role: string;
    sourcePath: string;
  }>;
  preferredMode?: PreferredSkillMode;
  repoRoot?: string;
  /** When true, skip reading bodies (native-only prep). Production never uses this path while unproven. */
  allowNativeAttempt?: boolean;
}

export interface ExecuteSkillsResult {
  results: SkillExecutionResult[];
  promptSuffix: string;
  skillProvenanceStatus: "present" | "none";
  nativeCapabilityState: ReturnType<typeof productionNativeSkillCapability>;
}

function resolvePreferredNative(
  preferredMode: PreferredSkillMode | undefined,
): boolean {
  if (preferredMode === "rendered_fallback") return false;
  if (preferredMode === "native_when_supported") return true;
  // automatic → only if supported
  return mayAttemptNativeSkillInProduction();
}

async function loadSkillBody(
  sourcePath: string,
  repoRoot: string,
): Promise<{ content: string; contentSha256: string } | null> {
  if (!sourcePath.startsWith(`${CANONICAL_SKILLS_DIR}/`)) {
    return null;
  }
  const abs = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.join(repoRoot, sourcePath);
  try {
    const content = await readFile(abs, "utf8");
    return { content, contentSha256: contentSha256Of(content) };
  } catch {
    return null;
  }
}

/**
 * Resolve skill inclusion for a phase. While native capability is unproven,
 * always renders skill bodies into the prompt and never claims discovery/invocation.
 */
export async function executeSkillsForPhase(
  params: ExecuteSkillsParams,
): Promise<ExecuteSkillsResult> {
  const repoRoot = params.repoRoot ?? process.cwd();
  const capability = productionNativeSkillCapability();
  const prefersNative = resolvePreferredNative(params.preferredMode);
  const wantNative =
    (params.allowNativeAttempt ?? false) &&
    prefersNative &&
    mayAttemptNativeSkillInProduction();
  const nativeBlockedReason = prefersNative
    ? (`native_capability_${capability}` as const)
    : undefined;

  const results: SkillExecutionResult[] = [];
  const sections: string[] = [];

  for (const req of params.requests) {
    const loaded = await loadSkillBody(req.sourcePath, repoRoot);
    if (!loaded) {
      results.push({
        skillId: req.skillId,
        role: req.role,
        sourcePath: req.sourcePath,
        contentSha256: "",
        requested: true,
        discovered: null,
        invoked: null,
        invocationMode: "none",
        evidenceSource: "none",
        inclusionMethod: "none",
        fallbackReason: "skill_file_unavailable",
      });
      continue;
    }

    const request: SkillExecutionRequest = {
      skillId: req.skillId,
      role: req.role,
      sourcePath: req.sourcePath,
      contentSha256: loaded.contentSha256,
      preferredMode: wantNative ? "native" : "rendered_fallback",
    };

    if (wantNative && capability === "supported") {
      // Reserved for post-canary: native reference only, no body.
      // Unreachable today because mayAttemptNativeSkillInProduction() is false.
      results.push({
        skillId: request.skillId,
        role: request.role,
        sourcePath: request.sourcePath,
        contentSha256: request.contentSha256,
        requested: true,
        discovered: null,
        invoked: null,
        invocationMode: "native_cursor_skill",
        evidenceSource: "requested_only",
        inclusionMethod: inclusionMethodForInvocation("native_cursor_skill"),
        fallbackReason: undefined,
      });
      sections.push(
        [
          "",
          "---",
          "",
          `## Native skill reference: ${request.skillId}`,
          "",
          `Use the project Agent Skill \`${request.skillId}\` (source \`${request.sourcePath}\`, sha256 ${request.contentSha256}).`,
          "Do not invent skill discovery or invocation evidence.",
          "",
        ].join("\n"),
      );
      continue;
    }

    // Production path: rendered_into_prompt
    results.push({
      skillId: request.skillId,
      role: request.role,
      sourcePath: request.sourcePath,
      contentSha256: request.contentSha256,
      requested: true,
      discovered: null,
      invoked: null,
      invocationMode: "rendered_into_prompt",
      evidenceSource: "local_render",
      inclusionMethod: "rendered_into_prompt",
      fallbackReason: nativeBlockedReason,
      renderedContent: loaded.content,
    });

    sections.push(
      [
        "",
        "---",
        "",
        `## Canonical skill: ${request.skillId}`,
        "",
        `Source: \`${request.sourcePath}\``,
        `Role: ${request.role}`,
        `Content SHA-256: ${request.contentSha256}`,
        `Invocation mode: rendered_into_prompt`,
        `Native capability: ${capability}`,
        "",
        loaded.content.trim(),
        "",
      ].join("\n"),
    );
  }

  const present = results.some((r) => r.invocationMode === "rendered_into_prompt");
  return {
    results,
    promptSuffix: sections.join("\n"),
    skillProvenanceStatus: present ? "present" : "none",
    nativeCapabilityState: capability,
  };
}

/**
 * Guard: never append full skill body when native mode was selected.
 * Used by tests and assembly checks.
 */
export function assertNoDuplicateSkillInjection(
  results: SkillExecutionResult[],
  finalPrompt: string,
): { ok: boolean; reason?: string } {
  for (const r of results) {
    if (
      r.invocationMode === "native_cursor_skill" &&
      r.renderedContent &&
      finalPrompt.includes(r.renderedContent.trim())
    ) {
      return {
        ok: false,
        reason: `Duplicate native+rendered injection for skill ${r.skillId}`,
      };
    }
  }
  return { ok: true };
}
