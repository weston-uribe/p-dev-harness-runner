import type { CanonicalStatusKey } from "@harness/workflow/canonical-product-development-workflow";
import type { MergePathVariant } from "@harness/workflow/canonical-product-development-workflow";
import type { PlanReviewReadinessView, CodeReviewReadinessView } from "@harness/workflow-page/types";

export type WorkflowStatusField = {
  label: string;
  value: string;
};

export type WorkflowStatusContent = {
  description: string;
  fields: WorkflowStatusField[];
  builderModelNote?: string;
  showPlannerModel?: boolean;
  showBuilderModel?: boolean;
  showBuilderModelReference?: boolean;
  showPlanReviewerModel?: boolean;
  showCodeReviewerModel?: boolean;
  showCodeReviserModel?: boolean;
  showOptionalPhaseControls?: boolean;
  independentAgentNote?: string;
};

const NO_DESTINATION = "No automatic destination.";

function destinations(...names: string[]): WorkflowStatusField {
  return { label: "Destinations", value: names.join(", ") };
}

function nextStatus(name: string): WorkflowStatusField {
  return { label: "Next status", value: name };
}

function onFailure(): WorkflowStatusField {
  return { label: "On failure", value: "Blocked" };
}

function success(name: string): WorkflowStatusField {
  return { label: "Success", value: name };
}

function failure(): WorkflowStatusField {
  return { label: "Failure", value: "Blocked" };
}

export const WORKFLOW_STATUS_CONTENT: Record<CanonicalStatusKey, WorkflowStatusContent> = {
  backlog: {
    description: "Work waiting for human triage.",
    fields: [destinations("Ready for Planning", "Ready for Build")],
  },
  "pm-review": {
    description: "Product review of the implemented change and preview.",
    fields: [destinations("Needs Revision", "Engineering Review")],
  },
  "engineering-review": {
    description: "Engineering approval before merge.",
    fields: [destinations("Needs Revision", "Ready to Merge")],
  },
  blocked: {
    description: "Automation stopped and requires human intervention.",
    fields: [{ label: "Destinations", value: NO_DESTINATION }],
  },
  canceled: {
    description: "Work intentionally stopped.",
    fields: [{ label: "Destinations", value: NO_DESTINATION }],
  },
  duplicate: {
    description: "Work closed because it duplicates another issue.",
    fields: [{ label: "Destinations", value: NO_DESTINATION }],
  },
  "ready-for-planning": {
    description: "The harness packages the issue and starts planning.",
    fields: [nextStatus("Planning"), onFailure()],
  },
  "ready-for-build": {
    description: "The harness assembles the implementation context and starts the Builder.",
    fields: [nextStatus("Building"), onFailure()],
  },
  "pr-open": {
    description:
      "The harness finds and inspects the implementation PR, captures preview information, and prepares the PM handoff.",
    fields: [nextStatus("PM Review"), onFailure()],
  },
  "needs-revision": {
    description:
      "The harness gathers review feedback and sends the existing PR back to the Builder in revision mode.",
    fields: [nextStatus("Revising"), onFailure()],
  },
  "ready-to-merge": {
    description: "The harness begins merge validation and execution.",
    fields: [nextStatus("Merging"), onFailure()],
  },
  merging: {
    description:
      "The harness evaluates checks, repairs integration problems when necessary, and performs the merge.",
    fields: [],
    builderModelNote: "Agent-based integration repair uses the Builder model.",
  },
  "merged-to-dev": {
    description:
      "The change is merged to the integration branch and is waiting for production promotion.",
    fields: [nextStatus("Merged / Deployed")],
  },
  "merged-deployed": {
    description: "The change has reached the configured production branch.",
    fields: [{ label: "Outcome", value: "Workflow complete." }],
  },
  planning: {
    description: "The Planner converts the issue into an implementation-ready plan.",
    fields: [success("Ready for Build"), failure()],
    showPlannerModel: true,
  },
  "plan-review": {
    description:
      "An independent Plan Reviewer agent evaluates the plan before implementation begins.",
    fields: [],
    showPlanReviewerModel: true,
    showOptionalPhaseControls: true,
    independentAgentNote:
      "Plan Review uses a separate agent role from Planning. It does not share the Planner session.",
  },
  "code-review": {
    description:
      "An independent Code Reviewer agent evaluates the implementation PR before PM review.",
    fields: [],
    showCodeReviewerModel: true,
    showOptionalPhaseControls: true,
    independentAgentNote:
      "Code Review uses a separate agent role from the Builder. It does not share the implementation session.",
  },
  "code-revision": {
    description:
      "The Code Reviser applies reviewer feedback to the existing branch and pull request.",
    fields: [],
    showCodeReviserModel: true,
    independentAgentNote:
      "Code Revision uses a dedicated reviser role. It is separate from PM/engineering revision (Needs Revision).",
  },
  building: {
    description:
      "The Builder implements the work, validates it, and creates or updates the pull request.",
    fields: [success("PR Open"), failure()],
    showBuilderModel: true,
  },
  revising: {
    description:
      "The same Builder role applies PM or engineering feedback to the existing branch and pull request.",
    fields: [success("PM Review"), failure()],
    showBuilderModelReference: true,
  },
};

export function getMergingDestinations(
  mergePathVariant: MergePathVariant,
): WorkflowStatusField {
  if (mergePathVariant === "direct-production") {
    return {
      label: "Destinations",
      value: "Merged / Deployed when integration and production branches are the same",
    };
  }
  return {
    label: "Destinations",
    value:
      "Merged to Dev when integration and production branches differ; Merged / Deployed when they are the same",
  };
}

export function resolvePlanReviewStatusContent(
  readiness: PlanReviewReadinessView,
): WorkflowStatusContent {
  const base = WORKFLOW_STATUS_CONTENT["plan-review"];

  if (readiness.uiState === "disabled") {
    return {
      ...base,
      fields: [
        {
          label: "Effective route",
          value: "Planning → Ready for Build (Plan Review bypassed)",
        },
      ],
    };
  }

  if (readiness.uiState === "setup_required") {
    return {
      ...base,
      fields: [
        {
          label: "Requested route",
          value: "Planning → Plan Review → Ready for Build",
        },
        {
          label: "Effective route",
          value: "Planning → Ready for Build (setup incomplete — Plan Review bypassed)",
        },
        {
          label: "Setup required",
          value: readiness.missingRequirementMessages.join(" "),
        },
      ],
    };
  }

  return {
    ...base,
    fields: [
      { label: "Entry", value: "Planning → Plan Review" },
      { label: "Approve", value: "Ready for Build" },
      {
        label: "Revise",
        value: "Ready for Planning → Planning → Plan Review (up to max cycles)",
      },
      failure(),
    ],
  };
}

export function resolveCodeReviewStatusContent(
  readiness: CodeReviewReadinessView,
): WorkflowStatusContent {
  const base = WORKFLOW_STATUS_CONTENT["code-review"];

  if (readiness.uiState === "disabled") {
    return {
      ...base,
      fields: [
        {
          label: "Effective route",
          value: "PR Open → PM Review (Code Review bypassed)",
        },
      ],
    };
  }

  if (readiness.uiState === "setup_required") {
    return {
      ...base,
      fields: [
        {
          label: "Requested route",
          value: "PR Open → Code Review → PM Review",
        },
        {
          label: "Effective route",
          value:
            "PR Open → PM Review (setup incomplete — Code Review bypassed)",
        },
        {
          label: "Revision path",
          value: "Code Review → Code Revision → Code Review (up to max cycles)",
        },
        {
          label: "Setup required",
          value: readiness.missingRequirementMessages.join(" "),
        },
      ],
    };
  }

  return {
    ...base,
    fields: [
      { label: "Entry", value: "PR Open → Code Review" },
      { label: "Approve", value: "PM Review" },
      {
        label: "Revise",
        value: "Code Revision → Code Review (up to max cycles)",
      },
      failure(),
    ],
  };
}

export function resolveStatusContent(
  statusKey: CanonicalStatusKey,
  mergePathVariant: MergePathVariant,
  planReviewReadiness?: PlanReviewReadinessView,
  codeReviewReadiness?: CodeReviewReadinessView,
): WorkflowStatusContent {
  if (statusKey === "plan-review" && planReviewReadiness) {
    return resolvePlanReviewStatusContent(planReviewReadiness);
  }
  if (statusKey === "code-review" && codeReviewReadiness) {
    return resolveCodeReviewStatusContent(codeReviewReadiness);
  }

  const base = WORKFLOW_STATUS_CONTENT[statusKey];
  if (statusKey === "merging") {
    return {
      ...base,
      fields: [getMergingDestinations(mergePathVariant), onFailure()],
    };
  }
  return base;
}
