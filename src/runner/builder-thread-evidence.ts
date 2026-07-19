import type { BuilderThreadResolution } from "./builder-thread-types.js";
import type { BuilderThreadMarkerEvidence } from "./builder-thread-types.js";

export function builderMarkerEvidenceFromResolution(
  continuity: BuilderThreadResolution,
  idempotencyKey: string,
): BuilderThreadMarkerEvidence {
  return {
    builderAgentId: continuity.reference.agentId,
    builderThreadGeneration: continuity.reference.generation,
    builderThreadAction: continuity.action,
    builderOriginRunId: continuity.reference.originHarnessRunId,
    builderThreadIdempotencyKey: idempotencyKey,
    previousBuilderAgentId: continuity.previousAgentId,
    builderThreadReplacementReason: continuity.replacementReason,
  };
}

export function builderManifestFieldsFromResolution(
  continuity: BuilderThreadResolution,
  cursorRequestId?: string,
): {
  builderAgentId: string;
  builderThreadAction: BuilderThreadResolution["action"];
  builderThreadGeneration: number;
  builderOriginRunId: string;
  previousBuilderAgentId: string | null;
  builderThreadReplacementReason: BuilderThreadResolution["replacementReason"];
  cursorRequestId: string | null;
} {
  return {
    builderAgentId: continuity.reference.agentId,
    builderThreadAction: continuity.action,
    builderThreadGeneration: continuity.reference.generation,
    builderOriginRunId: continuity.reference.originHarnessRunId,
    previousBuilderAgentId: continuity.previousAgentId ?? null,
    builderThreadReplacementReason: continuity.replacementReason ?? undefined,
    cursorRequestId: cursorRequestId ?? null,
  };
}
