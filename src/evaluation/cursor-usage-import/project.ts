import type { EvaluationScoreInput } from "../types.js";

export interface ScoreRecorder {
  recordScore: (input: EvaluationScoreInput) => void;
}

/**
 * Scores-only projection. Never touches observations / usageDetails / costDetails.
 */
export function projectUsageScoresOnly(params: {
  recorder: ScoreRecorder;
  scores: EvaluationScoreInput[];
}): { observationMutationAttempted: false; scoresWritten: number } {
  for (const score of params.scores) {
    params.recorder.recordScore(score);
  }
  return {
    observationMutationAttempted: false,
    scoresWritten: params.scores.length,
  };
}
