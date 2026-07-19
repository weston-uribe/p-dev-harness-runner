import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEvaluationSubjectsPath } from "../../artifacts/paths.js";
import type { EvaluationSubject } from "./types.js";
import { assertEvaluationSubject } from "./validate.js";

function subjectSortKey(subject: EvaluationSubject): string {
  return [
    subject.subjectType,
    subject.phase ?? "",
    subject.harnessRunId ?? "",
    subject.evaluationSubjectId,
  ].join("\0");
}

export async function readSubjects(
  evaluationDirectory: string,
): Promise<EvaluationSubject[]> {
  const filePath = getEvaluationSubjectsPath(evaluationDirectory);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const subjects: EvaluationSubject[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    subjects.push(assertEvaluationSubject(JSON.parse(trimmed)));
  }
  return subjects;
}

/**
 * Idempotent rewrite: merge by evaluationSubjectId, stable sort, atomic replace.
 * Does not mutate source evidence — only the session subjects.jsonl.
 */
export async function writeSubjectsIdempotent(
  evaluationDirectory: string,
  incoming: EvaluationSubject[],
): Promise<{ subjects: EvaluationSubject[]; duplicatesResolved: number }> {
  await mkdir(evaluationDirectory, { recursive: true });
  const existing = await readSubjects(evaluationDirectory);
  const byId = new Map<string, EvaluationSubject>();
  let duplicatesResolved = 0;

  for (const subject of existing) {
    byId.set(subject.evaluationSubjectId, subject);
  }
  for (const subject of incoming) {
    assertEvaluationSubject(subject);
    if (byId.has(subject.evaluationSubjectId)) {
      duplicatesResolved += 1;
    }
    byId.set(subject.evaluationSubjectId, subject);
  }

  const subjects = [...byId.values()].sort((a, b) =>
    subjectSortKey(a).localeCompare(subjectSortKey(b)),
  );

  const filePath = getEvaluationSubjectsPath(evaluationDirectory);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${subjects.map((s) => JSON.stringify(s)).join("\n")}${
    subjects.length > 0 ? "\n" : ""
  }`;
  await writeFile(tempPath, body, "utf8");
  await rename(tempPath, filePath);
  return { subjects, duplicatesResolved };
}

export function getSubjectsFilePath(evaluationDirectory: string): string {
  return path.resolve(getEvaluationSubjectsPath(evaluationDirectory));
}
