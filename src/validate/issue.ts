import { readFile } from "node:fs/promises";
import { loadHarnessConfig } from "../config/load-config.js";
import type { HarnessConfig } from "../config/types.js";
import { parseFixtureMarkdown } from "../fixture/frontmatter.js";
import { fetchLinearIssue } from "../linear/client.js";
import { parseIssueDescription } from "../linear/parser.js";
import { findLatestPlanningComment } from "../linear/planning-comment.js";
import { createLinearClient, listIssueComments } from "../linear/writer.js";
import { ResolverError } from "../resolver/errors.js";
import { resolveTargetRepo } from "../resolver/target-repo.js";
import type {
  IntendedPhase,
  IssueValidationResult,
  ValidateIssueOptions,
} from "./types.js";
import {
  type ProductInitializationState,
} from "../product/initialization-state.js";
import {
  getNarrowFailureReason,
  isNarrowImplementationIssue,
} from "../runner/idempotency.js";

function buildRepairInstructions(
  result: Omit<
    IssueValidationResult,
    "repairInstructions" | "passesIntendedPhase" | "intendedPhase"
  >,
  intendedPhase: IntendedPhase | null,
): string[] {
  const repairs: string[] = [];

  if (result.parseErrors.length > 0) {
    repairs.push(
      "Fix parser errors: add required ## sections (Task, Acceptance criteria, Out of scope) with hyphen bullets for criteria and out-of-scope items.",
    );
    for (const error of result.parseErrors) {
      repairs.push(`- ${error}`);
    }
  }

  if (result.resolverError) {
    if (result.resolverError.classification === "missing_target_repo") {
      repairs.push(
        "Assign the issue to a mapped Linear project (see harness.config.json linearProjects) or add ## Target repo / Target repo: under ## Context and links.",
      );
    } else if (result.resolverError.classification === "unknown_repo_denied") {
      repairs.push(
        "Use a repo listed in harness.config.json allowedTargetRepos, or add the repo to the allowlist.",
      );
    } else {
      repairs.push(result.resolverError.message);
    }
  }

  if (
    result.blocksDirectImplementationForUninitializedProduct &&
    intendedPhase === "implementation"
  ) {
    repairs.push(
      "Product is uninitialized — complete product foundation planning before Ready for Build.",
    );
    repairs.push(
      "Set Linear status to Ready for Planning and run the foundation planning issue first.",
    );
  }

  if (
    result.validForPlanning &&
    !result.validForDirectImplementation &&
    intendedPhase === "implementation"
  ) {
    if (result.blocksDirectImplementationForUninitializedProduct) {
      repairs.push(
        "Product is uninitialized — complete product foundation planning before Ready for Build.",
      );
    }
  }

  if (!result.validForPlanning && intendedPhase === "planning") {
    repairs.push(
      "Issue is not ready for Ready for Planning — resolve parser and target repo errors first.",
    );
  }

  return repairs;
}

function buildRoutingNotes(
  validForPlanning: boolean,
  validForDirectImplementation: boolean,
  narrowIssue: boolean,
  hasPlanningMarker: boolean,
  intendedPhase: IntendedPhase | null,
  resolutionSource: IssueValidationResult["resolutionSource"],
  blocksDirectImplementationForUninitializedProduct: boolean,
  productInitializationState: ProductInitializationState | null,
): string[] {
  const notes: string[] = [];

  if (resolutionSource === "project") {
    notes.push("Target repo derived from Linear project mapping.");
  } else if (resolutionSource === "team") {
    notes.push("Target repo derived from Linear team mapping.");
  }

  if (validForPlanning) {
    notes.push("Set Linear status to Ready for Planning to run the planning phase.");
  }

  if (validForDirectImplementation) {
    notes.push(
      "Set Linear status to Ready for Build to run implementation directly. Linear status is authoritative; a planning comment is optional supplemental context.",
    );
  }

  if (validForPlanning && !narrowIssue) {
    notes.push(
      "Advisory: issue exceeds narrow-size heuristics — consider Ready for Planning first, but Ready for Build will still execute if selected.",
    );
    if (hasPlanningMarker) {
      notes.push(
        "Durable planning comment found — it will be included as supplemental implementation context.",
      );
    }
  } else if (hasPlanningMarker) {
    notes.push(
      "Durable planning comment found — it will be included as supplemental implementation context.",
    );
  }

  if (blocksDirectImplementationForUninitializedProduct) {
    notes.push(
      "Target product is uninitialized — route foundation work through Ready for Planning first.",
    );
  }

  if (productInitializationState === "initialized") {
    notes.push("Target product marker reports initialized status.");
  }

  if (intendedPhase === "implementation" && validForPlanning && !validForDirectImplementation) {
    notes.push("Recommended status should be Ready for Planning, not Ready for Build.");
  }

  return notes;
}

export function computeIssueValidation(
  description: string,
  context: {
    projectName?: string;
    teamName?: string;
    teamKey?: string;
    teamId?: string;
    projectId?: string;
  },
  config: HarnessConfig,
  options: {
    intendedPhase?: IntendedPhase;
    hasPlanningMarker?: boolean;
    planningMarkerMode: "file" | "issue";
    productInitializationState?: ProductInitializationState | null;
  },
): IssueValidationResult {
  const intendedPhase = options.intendedPhase ?? null;
  const hasPlanningMarker = options.hasPlanningMarker ?? false;
  const productInitializationState = options.productInitializationState ?? null;
  const parsed = parseIssueDescription(description);
  const parseErrors = [...parsed.parseErrors];

  let targetRepo: string | null = null;
  let resolutionSource: IssueValidationResult["resolutionSource"] = null;
  let resolverError: IssueValidationResult["resolverError"] = null;

  if (parseErrors.length === 0) {
    try {
      const resolved = resolveTargetRepo(parsed, context, config);
      targetRepo = resolved.targetRepo;
      resolutionSource = resolved.resolutionSource;
    } catch (error) {
      if (error instanceof ResolverError) {
        resolverError = {
          classification: error.classification,
          message: error.message,
        };
      } else {
        resolverError = {
          classification: "ambiguous_issue",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const validForPlanning = parseErrors.length === 0 && resolverError === null;
  const narrowIssue = isNarrowImplementationIssue(parsed);
  const narrowFailureReason = getNarrowFailureReason(parsed);
  const blocksDirectImplementationForUninitializedProduct =
    productInitializationState === "uninitialized";
  // Linear status is authoritative: Ready for Build does not require narrow size
  // or a prior planning comment. Uninitialized product remains a foundation gate.
  const validForDirectImplementation =
    validForPlanning && !blocksDirectImplementationForUninitializedProduct;

  const routingNotes = buildRoutingNotes(
    validForPlanning,
    validForDirectImplementation,
    narrowIssue,
    hasPlanningMarker,
    intendedPhase,
    resolutionSource,
    blocksDirectImplementationForUninitializedProduct,
    productInitializationState,
  );

  const base = {
    validForPlanning,
    validForDirectImplementation,
    targetRepo,
    resolutionSource,
    parseErrors,
    resolverError,
    narrowIssue,
    narrowFailureReason,
    hasPlanningMarker,
    planningMarkerMode: options.planningMarkerMode,
    productInitializationState,
    blocksDirectImplementationForUninitializedProduct,
    routingNotes,
  };

  const repairInstructions = buildRepairInstructions(base, intendedPhase);

  let passesIntendedPhase: boolean | null = null;
  if (intendedPhase === "planning") {
    passesIntendedPhase = validForPlanning;
  } else if (intendedPhase === "implementation") {
    passesIntendedPhase = validForDirectImplementation;
  }

  return {
    ...base,
    intendedPhase,
    passesIntendedPhase,
    repairInstructions,
  };
}

export async function validateIssueFromFile(
  filePath: string,
  config: HarnessConfig,
  intendedPhase?: IntendedPhase,
): Promise<IssueValidationResult> {
  const raw = await readFile(filePath, "utf8");
  const { metadata, body } = parseFixtureMarkdown(raw);

  return computeIssueValidation(
    body,
    {
      projectName: metadata.projectName ?? undefined,
      teamName: metadata.teamName ?? undefined,
    },
    config,
    { intendedPhase, hasPlanningMarker: false, planningMarkerMode: "file" },
  );
}

export async function validateIssueFromLinear(
  issueKey: string,
  config: HarnessConfig,
  linearApiKey: string,
  intendedPhase?: IntendedPhase,
): Promise<IssueValidationResult> {
  const issue = await fetchLinearIssue(issueKey, linearApiKey);
  const client = createLinearClient(linearApiKey);
  const comments = await listIssueComments(client, issue.id);
  const planningComment = findLatestPlanningComment(
    comments,
    config.orchestratorMarker,
  );

  return computeIssueValidation(
    issue.description ?? "",
    {
      projectName: issue.projectName ?? undefined,
      teamName: issue.teamName ?? undefined,
      teamKey: issue.teamKey ?? undefined,
      teamId: issue.teamId ?? undefined,
      projectId: issue.projectId ?? undefined,
    },
    config,
    {
      intendedPhase,
      hasPlanningMarker: planningComment !== null,
      planningMarkerMode: "issue",
    },
  );
}

export async function validateIssue(
  options: ValidateIssueOptions,
): Promise<IssueValidationResult> {
  const { config } = await loadHarnessConfig({ configPath: options.configPath });

  if (options.filePath) {
    return validateIssueFromFile(options.filePath, config, options.intendedPhase);
  }

  if (options.issueKey) {
    const apiKey = options.linearApiKey ?? process.env.LINEAR_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("LINEAR_API_KEY is required for --issue validation");
    }
    return validateIssueFromLinear(
      options.issueKey,
      config,
      apiKey,
      options.intendedPhase,
    );
  }

  throw new Error("Either filePath or issueKey is required");
}

export function resolveValidationExitCode(
  result: IssueValidationResult,
): number {
  if (result.intendedPhase === "implementation") {
    return result.validForDirectImplementation ? 0 : 2;
  }
  return result.validForPlanning ? 0 : 2;
}
