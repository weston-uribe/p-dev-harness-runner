import type {
  EvaluationRubric,
  RubricDimension,
  RubricJudgmentChannel,
} from "./types.js";

const RESPONSE_TYPES = new Set([
  "boolean",
  "numeric",
  "categorical",
  "ordinal",
  "free_text",
]);

const JUDGMENT_CHANNELS = new Set<RubricJudgmentChannel>(["human", "machine"]);

function validateDimension(dimension: RubricDimension, path: string): string[] {
  const errors: string[] = [];
  if (!dimension.dimensionId) errors.push(`${path}: missing dimensionId`);
  if (!dimension.name) errors.push(`${path}: missing name`);
  if (!RESPONSE_TYPES.has(dimension.responseType)) {
    errors.push(`${path}: invalid responseType`);
  }
  if (!Array.isArray(dimension.anchors) || dimension.anchors.length === 0) {
    errors.push(`${path}: anchors required`);
  } else {
    for (const [i, anchor] of dimension.anchors.entries()) {
      if (anchor.value === undefined || anchor.value === null) {
        errors.push(`${path}.anchors[${i}]: missing value`);
      }
      if (!anchor.label || !anchor.definition) {
        errors.push(`${path}.anchors[${i}]: label and definition required`);
      }
    }
  }
  if (
    (dimension.responseType === "ordinal" ||
      dimension.responseType === "categorical" ||
      dimension.responseType === "boolean") &&
    (!dimension.allowedValues || dimension.allowedValues.length === 0)
  ) {
    errors.push(`${path}: allowedValues required for ${dimension.responseType}`);
  }
  if (dimension.responseType === "numeric") {
    if (
      typeof dimension.numericMin !== "number" ||
      typeof dimension.numericMax !== "number"
    ) {
      errors.push(`${path}: numericMin/numericMax required`);
    }
  }
  if (
    dimension.applicableSubjectTypes !== undefined &&
    (!Array.isArray(dimension.applicableSubjectTypes) ||
      dimension.applicableSubjectTypes.length === 0)
  ) {
    errors.push(`${path}: applicableSubjectTypes must be a non-empty array when set`);
  }
  if (
    dimension.applicablePhases !== undefined &&
    dimension.applicablePhases !== null &&
    !Array.isArray(dimension.applicablePhases)
  ) {
    errors.push(`${path}: applicablePhases must be array or null when set`);
  }
  return errors;
}

export function validateRubric(rubric: unknown): {
  ok: boolean;
  errors: string[];
  rubric?: EvaluationRubric;
} {
  const errors: string[] = [];
  if (!rubric || typeof rubric !== "object") {
    return { ok: false, errors: ["rubric must be an object"] };
  }
  const r = rubric as EvaluationRubric;
  if (!r.rubricId) errors.push("rubricId required");
  if (!r.rubricVersion) errors.push("rubricVersion required");
  if (!r.name) errors.push("name required");
  if (!r.description) errors.push("description required");
  if (
    r.judgmentChannel === undefined ||
    r.judgmentChannel === null ||
    (r.judgmentChannel as string) === ""
  ) {
    errors.push("judgmentChannel required");
  } else if (!JUDGMENT_CHANNELS.has(r.judgmentChannel)) {
    errors.push(`judgmentChannel invalid: ${String(r.judgmentChannel)}`);
  }
  if (!Array.isArray(r.applicableSubjectTypes) || r.applicableSubjectTypes.length === 0) {
    errors.push("applicableSubjectTypes required");
  }
  if (r.applicablePhases !== null && !Array.isArray(r.applicablePhases)) {
    errors.push("applicablePhases must be array or null");
  }
  if (!Array.isArray(r.dimensions) || r.dimensions.length === 0) {
    errors.push("dimensions required");
  } else {
    const ids = new Set<string>();
    for (const [i, dim] of r.dimensions.entries()) {
      errors.push(...validateDimension(dim, `dimensions[${i}]`));
      if (ids.has(dim.dimensionId)) {
        errors.push(`duplicate dimensionId: ${dim.dimensionId}`);
      }
      ids.add(dim.dimensionId);
    }
  }
  return errors.length === 0
    ? { ok: true, errors: [], rubric: r }
    : { ok: false, errors };
}

export function assertValidRubric(rubric: unknown): EvaluationRubric {
  const result = validateRubric(rubric);
  if (!result.ok || !result.rubric) {
    throw new Error(`Invalid rubric: ${result.errors.join("; ")}`);
  }
  return result.rubric;
}
