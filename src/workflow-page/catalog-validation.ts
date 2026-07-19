import type { RoleModelRole } from "../config/role-models.js";
import { lookupModelInCatalog } from "./model-catalog-lookup.js";
import type {
  ModelSaveReadiness,
  WorkflowModelCatalogEntry,
  WorkflowModelSelection,
  WorkflowRoleModelSaveReadiness,
} from "./types.js";

export interface ModelSaveSelectionInput {
  modelId: string;
  parameters: Array<{ id: string; value: string }>;
}

export interface ModelSaveValidationResult {
  valid: boolean;
  issues: string[];
  state: WorkflowRoleModelSaveReadiness["state"];
}

function validateParameterValue(input: {
  parameterId: string;
  value: string;
  definition: WorkflowModelCatalogEntry["supportedParameters"][number];
}): string | undefined {
  const { parameterId, value, definition } = input;
  if (definition.type === "boolean") {
    if (value !== "true" && value !== "false") {
      return `Parameter "${parameterId}" must be "true" or "false".`;
    }
    return undefined;
  }

  if (definition.allowedValues?.length) {
    if (!definition.allowedValues.includes(value)) {
      return `Parameter "${parameterId}" value "${value}" is not allowed. Expected one of: ${definition.allowedValues.join(", ")}.`;
    }
  }

  return undefined;
}

export function validateModelSelectionAgainstCatalog(input: {
  role: RoleModelRole;
  selection: ModelSaveSelectionInput;
  modelCatalog: WorkflowModelCatalogEntry[];
  catalogLoaded: boolean;
}): WorkflowRoleModelSaveReadiness {
  const issues: string[] = [];

  if (!input.catalogLoaded) {
    return {
      role: input.role,
      ready: false,
      state: "catalog-unavailable",
      issues: [
        "Model catalog is unavailable, so model selections cannot be validated for save.",
      ],
    };
  }

  const model = lookupModelInCatalog(input.modelCatalog, input.selection.modelId);
  if (!model || model.availability !== "available") {
    issues.push(
      `Model "${input.selection.modelId}" is unavailable in the current catalog.`,
    );
    return {
      role: input.role,
      ready: false,
      state: "invalid-model",
      issues,
    };
  }

  let hasInvalidParameter = false;
  for (const parameter of input.selection.parameters) {
    const definition = model.supportedParameters.find(
      (entry) => entry.id === parameter.id,
    );
    if (!definition) {
      issues.push(`Model parameter "${parameter.id}" is not supported.`);
      hasInvalidParameter = true;
      continue;
    }

    const valueIssue = validateParameterValue({
      parameterId: parameter.id,
      value: parameter.value,
      definition,
    });
    if (valueIssue) {
      issues.push(valueIssue);
      hasInvalidParameter = true;
    }
  }

  if (hasInvalidParameter) {
    return {
      role: input.role,
      ready: false,
      state: "invalid-parameter",
      issues,
    };
  }

  return {
    role: input.role,
    ready: true,
    state: "ready",
    issues,
  };
}

export function buildModelSaveReadiness(input: {
  plannerSelection: WorkflowModelSelection;
  builderSelection: WorkflowModelSelection;
  planReviewerSelection: WorkflowModelSelection;
  codeReviewerSelection: WorkflowModelSelection;
  codeReviserSelection: WorkflowModelSelection;
  modelCatalog: WorkflowModelCatalogEntry[];
  catalogLoaded: boolean;
}): ModelSaveReadiness {
  const planner = validateModelSelectionAgainstCatalog({
    role: "planner",
    selection: {
      modelId: input.plannerSelection.modelId,
      parameters: input.plannerSelection.parameters,
    },
    modelCatalog: input.modelCatalog,
    catalogLoaded: input.catalogLoaded,
  });
  const builder = validateModelSelectionAgainstCatalog({
    role: "builder",
    selection: {
      modelId: input.builderSelection.modelId,
      parameters: input.builderSelection.parameters,
    },
    modelCatalog: input.modelCatalog,
    catalogLoaded: input.catalogLoaded,
  });
  const planReviewer = validateModelSelectionAgainstCatalog({
    role: "planReviewer",
    selection: {
      modelId: input.planReviewerSelection.modelId,
      parameters: input.planReviewerSelection.parameters,
    },
    modelCatalog: input.modelCatalog,
    catalogLoaded: input.catalogLoaded,
  });
  const codeReviewer = validateModelSelectionAgainstCatalog({
    role: "codeReviewer",
    selection: {
      modelId: input.codeReviewerSelection.modelId,
      parameters: input.codeReviewerSelection.parameters,
    },
    modelCatalog: input.modelCatalog,
    catalogLoaded: input.catalogLoaded,
  });
  const codeReviser = validateModelSelectionAgainstCatalog({
    role: "codeReviser",
    selection: {
      modelId: input.codeReviserSelection.modelId,
      parameters: input.codeReviserSelection.parameters,
    },
    modelCatalog: input.modelCatalog,
    catalogLoaded: input.catalogLoaded,
  });

  return {
    planner,
    builder,
    planReviewer,
    codeReviewer,
    codeReviser,
    ready:
      planner.ready &&
      builder.ready &&
      planReviewer.ready &&
      codeReviewer.ready &&
      codeReviser.ready,
  };
}

export function validateModelSavePayload(input: {
  role: RoleModelRole;
  selection: ModelSaveSelectionInput;
  modelCatalog: WorkflowModelCatalogEntry[];
  catalogLoaded: boolean;
}): ModelSaveValidationResult {
  const readiness = validateModelSelectionAgainstCatalog(input);
  return {
    valid: readiness.ready,
    issues: readiness.issues,
    state: readiness.state,
  };
}
