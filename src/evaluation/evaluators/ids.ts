import { createHash } from "node:crypto";
import type { ResolvedEvidenceItem } from "./types.js";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function deriveEvidenceFingerprint(params: {
  evidenceItems: ResolvedEvidenceItem[];
  dependencyResultIds: string[];
  subjectSchemaVersion: number | string;
  rubricDefinitionHash: string;
  evaluatorImplementationHash: string;
}): string {
  const evidenceLines = [...params.evidenceItems]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((item) => {
      if (item.untrusted) {
        return `${item.key}|untrusted|${item.untrustedReason ?? "unknown"}|${item.path ?? ""}|${item.sha256 ?? ""}`;
      }
      if (!item.present) {
        return `${item.key}|absent`;
      }
      return `${item.key}|present|${item.path ?? ""}|${item.sha256 ?? ""}`;
    });
  const deps = [...params.dependencyResultIds].sort();
  const payload = [
    `subjectSchema:${params.subjectSchemaVersion}`,
    `rubricHash:${params.rubricDefinitionHash}`,
    `implHash:${params.evaluatorImplementationHash}`,
    `evidence:${evidenceLines.join(";")}`,
    `deps:${deps.join(",")}`,
  ].join("\n");
  return sha256Hex(payload);
}

export function deriveEvaluatorResultId(params: {
  evaluationSubjectId: string;
  evaluatorId: string;
  evaluatorVersion: string;
  evaluatorImplementationHash: string;
  rubricId: string;
  rubricVersion: string;
  rubricDefinitionHash: string;
  dimensionId: string;
  evidenceFingerprint: string;
}): string {
  const seed = [
    "p-dev:evaluator-result:v1",
    params.evaluationSubjectId,
    params.evaluatorId,
    params.evaluatorVersion,
    params.evaluatorImplementationHash,
    params.rubricId,
    params.rubricVersion,
    params.rubricDefinitionHash,
    params.dimensionId,
    params.evidenceFingerprint,
  ].join(":");
  return sha256Hex(seed);
}

export function exactLineageKey(params: {
  evaluationSubjectId: string;
  evaluatorId: string;
  evaluatorVersion: string;
  evaluatorImplementationHash: string;
  rubricId: string;
  rubricVersion: string;
  rubricDefinitionHash: string;
  dimensionId: string;
}): string {
  return [
    params.evaluationSubjectId,
    params.evaluatorId,
    params.evaluatorVersion,
    params.evaluatorImplementationHash,
    params.rubricId,
    params.rubricVersion,
    params.rubricDefinitionHash,
    params.dimensionId,
  ].join("\0");
}
