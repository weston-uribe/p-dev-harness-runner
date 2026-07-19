import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEvaluationOutcomesPath } from "../artifacts/paths.js";
import type { EvaluationScoreInput } from "./types.js";

export const OUTCOME_ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface EvaluationOutcomeArtifact {
  schemaVersion: typeof OUTCOME_ARTIFACT_SCHEMA_VERSION;
  sessionId: string;
  traceId: string;
  scores: Array<{
    id: string;
    target: "trace" | "session";
    name: string;
    dataType: "BOOLEAN" | "NUMERIC" | "CATEGORICAL";
    value: boolean | number | string;
    timestamp: string;
  }>;
}

export async function writeEvaluationOutcomeArtifact(
  runDirectory: string,
  params: {
    sessionId: string;
    traceId: string;
    scores: EvaluationScoreInput[];
  },
): Promise<void> {
  if (!runDirectory || params.scores.length === 0) {
    return;
  }

  const artifact: EvaluationOutcomeArtifact = {
    schemaVersion: OUTCOME_ARTIFACT_SCHEMA_VERSION,
    sessionId: params.sessionId,
    traceId: params.traceId,
    scores: params.scores.map((score) => ({
      id: score.id,
      target: score.target,
      name: score.name,
      dataType: score.dataType,
      value: score.value,
      timestamp: score.timestamp,
    })),
  };

  const outcomesPath = getEvaluationOutcomesPath(runDirectory);
  await mkdir(path.dirname(outcomesPath), { recursive: true });
  await writeFile(outcomesPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
