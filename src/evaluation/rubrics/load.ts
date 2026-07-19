import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeRubricDefinitionHash } from "./hash.js";
import type { EvaluationRubric, RubricJudgmentChannel } from "./types.js";
import { assertValidRubric } from "./validate.js";

function definitionsDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "definitions");
}

export function getRubricDefinitionsDirectory(): string {
  return definitionsDirectory();
}

export async function loadRubricFromFile(
  filePath: string,
): Promise<EvaluationRubric> {
  const raw = await readFile(filePath, "utf8");
  return assertValidRubric(JSON.parse(raw));
}

export async function loadAllRubrics(
  directory = definitionsDirectory(),
): Promise<EvaluationRubric[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    throw new Error(
      `Unable to read rubric definitions at ${directory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const jsonFiles = entries.filter((name) => name.endsWith(".json")).sort();
  const rubrics: EvaluationRubric[] = [];
  const seen = new Map<string, { file: string; hash: string }>();
  for (const name of jsonFiles) {
    const filePath = path.join(directory, name);
    const rubric = await loadRubricFromFile(filePath);
    const key = `${rubric.rubricId}\0${rubric.rubricVersion}`;
    const hash = computeRubricDefinitionHash(rubric);
    const prior = seen.get(key);
    if (prior && prior.hash !== hash) {
      throw new Error(
        `Duplicate rubricId+rubricVersion with different content: ${rubric.rubricId}@${rubric.rubricVersion} (${prior.file} vs ${name})`,
      );
    }
    if (!prior) {
      seen.set(key, { file: name, hash });
      rubrics.push(rubric);
    }
  }
  return rubrics;
}

export async function getRubric(
  rubricId: string,
  rubricVersion: string,
): Promise<EvaluationRubric | null> {
  const all = await loadAllRubrics();
  return (
    all.find(
      (r) => r.rubricId === rubricId && r.rubricVersion === rubricVersion,
    ) ?? null
  );
}

export async function getRubricWithHash(
  rubricId: string,
  rubricVersion: string,
): Promise<{ rubric: EvaluationRubric; rubricDefinitionHash: string } | null> {
  const rubric = await getRubric(rubricId, rubricVersion);
  if (!rubric) return null;
  return {
    rubric,
    rubricDefinitionHash: computeRubricDefinitionHash(rubric),
  };
}

export async function listRubricsForSubject(params: {
  subjectType: string;
  phase: string | null;
  /** Required filter — callers must pass explicitly. */
  judgmentChannel: RubricJudgmentChannel;
}): Promise<EvaluationRubric[]> {
  const all = await loadAllRubrics();
  return all.filter((rubric) => {
    if (rubric.deprecated) return false;
    if (rubric.judgmentChannel !== params.judgmentChannel) return false;
    if (!rubric.applicableSubjectTypes.includes(params.subjectType as never)) {
      return false;
    }
    if (rubric.applicablePhases == null) return true;
    if (params.phase == null) return false;
    return rubric.applicablePhases.includes(params.phase as never);
  });
}

/** Resolve effective applicability for a dimension (inherits rubric when unset). */
export function resolveDimensionApplicability(
  rubric: EvaluationRubric,
  dimensionId: string,
): {
  applicableSubjectTypes: EvaluationRubric["applicableSubjectTypes"];
  applicablePhases: EvaluationRubric["applicablePhases"];
} {
  const dim = rubric.dimensions.find((d) => d.dimensionId === dimensionId);
  if (!dim) {
    return {
      applicableSubjectTypes: rubric.applicableSubjectTypes,
      applicablePhases: rubric.applicablePhases,
    };
  }
  return {
    applicableSubjectTypes:
      dim.applicableSubjectTypes ?? rubric.applicableSubjectTypes,
    applicablePhases:
      dim.applicablePhases !== undefined
        ? dim.applicablePhases
        : rubric.applicablePhases,
  };
}
