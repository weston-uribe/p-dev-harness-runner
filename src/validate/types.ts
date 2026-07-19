import type { ErrorClassification } from "../resolver/errors.js";
import type { ResolvedTarget } from "../resolver/target-repo.js";
import type { ProductInitializationState } from "../product/initialization-state.js";

export type IntendedPhase = "planning" | "implementation";

export interface IssueValidationResult {
  validForPlanning: boolean;
  validForDirectImplementation: boolean;
  intendedPhase: IntendedPhase | null;
  passesIntendedPhase: boolean | null;
  targetRepo: string | null;
  resolutionSource: ResolvedTarget["resolutionSource"] | null;
  parseErrors: string[];
  resolverError: { classification: ErrorClassification; message: string } | null;
  narrowIssue: boolean;
  narrowFailureReason: string | null;
  hasPlanningMarker: boolean;
  planningMarkerMode: "file" | "issue";
  productInitializationState: ProductInitializationState | null;
  blocksDirectImplementationForUninitializedProduct: boolean;
  routingNotes: string[];
  repairInstructions: string[];
}

export interface ValidateIssueOptions {
  configPath: string;
  intendedPhase?: IntendedPhase;
  filePath?: string;
  issueKey?: string;
  linearApiKey?: string;
}
