import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEvaluatorResultsPath } from "../../artifacts/paths.js";
import { assertValidEvaluatorResult } from "./validate.js";
import type { EvaluatorResult } from "./types.js";

export async function readEvaluatorResults(
  evaluationDirectory: string,
): Promise<EvaluatorResult[]> {
  const filePath = getEvaluatorResultsPath(evaluationDirectory);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
  const results: EvaluatorResult[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    results.push(assertValidEvaluatorResult(JSON.parse(line)));
  }
  return results.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
}

/**
 * Append results in stable order. Rejects duplicate IDs.
 * Uses temp file + rename for atomicity of the full rewrite after append.
 */
export async function commitEvaluatorResults(params: {
  evaluationDirectory: string;
  existing: EvaluatorResult[];
  candidates: EvaluatorResult[];
}): Promise<{ appended: EvaluatorResult[]; reusedIds: string[] }> {
  await mkdir(params.evaluationDirectory, { recursive: true });
  const byId = new Map(
    params.existing.map((r) => [r.evaluatorResultId, r] as const),
  );
  const appended: EvaluatorResult[] = [];
  const reusedIds: string[] = [];

  const ordered = [...params.candidates].sort((a, b) => {
    const s = a.evaluationSubjectId.localeCompare(b.evaluationSubjectId);
    if (s !== 0) return s;
    const e = a.evaluatorId.localeCompare(b.evaluatorId);
    if (e !== 0) return e;
    return a.dimensionId.localeCompare(b.dimensionId);
  });

  for (const candidate of ordered) {
    assertValidEvaluatorResult(candidate);
    const existing = byId.get(candidate.evaluatorResultId);
    if (existing) {
      reusedIds.push(candidate.evaluatorResultId);
      continue;
    }
    byId.set(candidate.evaluatorResultId, candidate);
    appended.push(candidate);
  }

  if (appended.length === 0) {
    return { appended, reusedIds };
  }

  const all = [...params.existing, ...appended].sort((a, b) =>
    a.completedAt.localeCompare(b.completedAt),
  );
  const filePath = getEvaluatorResultsPath(params.evaluationDirectory);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = all.map((r) => JSON.stringify(r)).join("\n") + (all.length ? "\n" : "");
  await writeFile(tmp, body, "utf8");
  await rename(tmp, filePath);
  return { appended, reusedIds };
}

export async function validateEvaluatorResultsStore(
  evaluationDirectory: string,
): Promise<{ ok: boolean; errors: string[]; count: number }> {
  const errors: string[] = [];
  let results: EvaluatorResult[] = [];
  try {
    results = await readEvaluatorResults(evaluationDirectory);
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      count: 0,
    };
  }
  const ids = new Set<string>();
  for (const r of results) {
    if (ids.has(r.evaluatorResultId)) {
      errors.push(`duplicate evaluatorResultId: ${r.evaluatorResultId}`);
    }
    ids.add(r.evaluatorResultId);
    if (
      r.supersedesEvaluatorResultId &&
      !ids.has(r.supersedesEvaluatorResultId) &&
      !results.some((x) => x.evaluatorResultId === r.supersedesEvaluatorResultId)
    ) {
      // supersedes may point to earlier in file — check full set
      if (
        !results.some(
          (x) => x.evaluatorResultId === r.supersedesEvaluatorResultId,
        )
      ) {
        errors.push(
          `missing supersedes target: ${r.supersedesEvaluatorResultId}`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors, count: results.length };
}

export function evaluatorResultsPath(evaluationDirectory: string): string {
  return getEvaluatorResultsPath(evaluationDirectory);
}

export function tmpPathForTests(evaluationDirectory: string): string {
  return path.join(evaluationDirectory, "evaluator-results.jsonl");
}
