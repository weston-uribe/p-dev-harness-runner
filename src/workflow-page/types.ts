import type {
  CanonicalStatusKey,
} from "../workflow/canonical-product-development-workflow.js";
import type { RequiredWorkflowStatus } from "../setup/linear-status-contract.js";
import type { CanonicalValidationViolation } from "../workflow/canonical-workflow-validation.js";
import type { PlanReviewUiState } from "../workflow/plan-review-readiness.js";
import type { CodeReviewUiState } from "../workflow/code-review-readiness.js";
import type { RoleModelRole } from "../config/role-models.js";

export type WorkflowSourceMode = "live" | "fixture";

export type WorkflowHealthState =
  | "healthy"
  | "blocking-configuration-error"
  | "linear-unavailable";

export interface WorkflowStatusRecord {
  id: string;
  name: string;
  category: string;
  color?: string;
  source: "linear-live" | "fixture";
  requiredWorkflowRole?: RequiredWorkflowStatus["role"];
  participatesInCurrentHarnessWorkflow: boolean;
  automationTriggerStatus: boolean;
  currentMappingKeys: string[];
  mappingState: "resolved" | "ambiguous" | "missing" | "unmapped";
  canonicalStatusKey?: CanonicalStatusKey;
}

export interface WorkflowModelParameterDefinition {
  id: string;
  label: string;
  type: "boolean" | "string" | "enum";
  allowedValues?: string[];
  defaultValue?: string;
}

export interface WorkflowModelCatalogEntry {
  id: string;
  displayName: string;
  availability: "available" | "missing" | "catalog-unavailable";
  supportedParameters: WorkflowModelParameterDefinition[];
  fetchedAt?: string;
  source: "cursor-live" | "fixture";
  /** True when the model advertises a configurable Fast parameter. */
  fastModeAvailable?: boolean;
  /** Cursor-advertised defaults if params omitted (may be Fast for Composer). */
  providerDefaultParams?: Array<{ id: string; value: string }>;
  /** PDev product defaults when stored preference is missing (Standard for Composer). */
  harnessDefaultParams?: Array<{ id: string; value: string }>;
}

export type WorkflowModelSelectionSource =
  | "roleModels"
  | "agentProvider.model.id"
  | "defaultModel.id"
  | "code-default";

export type WorkflowParameterEvidenceSource =
  | "stored"
  | "harness_default_pin"
  | "unsupported"
  | "provider_default";

export type WorkflowEffectiveVariant = "standard" | "fast" | "none";

export interface WorkflowModelSelection {
  modelId: string;
  displayName: string;
  /** Effective requested params for display/execution (may include harness pin). */
  parameters: Array<{ id: string; value: string }>;
  /** Params actually stored in config; may omit Fast. */
  storedParameters?: Array<{ id: string; value: string }>;
  source: WorkflowModelSelectionSource;
  parameterEvidenceSource?: WorkflowParameterEvidenceSource;
  effectiveVariant?: WorkflowEffectiveVariant;
  variantSummary?: string;
}

export interface WorkflowCurrentWorkflowMapping {
  mappingKey: string;
  configuredStatusName: string;
  resolvedStatusIds: string[];
  state: "resolved" | "ambiguous" | "missing";
}

export interface WorkflowScope {
  id: string;
  targetRepo: string;
  baseBranch?: string;
  productionBranch?: string;
  linearTeams?: string[];
  linearProjects?: string[];
}

export type CatalogLoadState = "loaded" | "unavailable";

export interface WorkflowCatalogLoadMetadata {
  statusCatalog: CatalogLoadState;
  modelCatalog: CatalogLoadState;
}

export interface WorkflowSourceContext {
  mode: WorkflowSourceMode;
  fixtureId?: string;
  scopeId?: string;
  fixturesEnabled: boolean;
  rejectionReason?: string;
}

export interface WorkflowCanonicalWorkflowView {
  healthState: WorkflowHealthState;
  violations: CanonicalValidationViolation[];
  informationalWarnings: import("../workflow/canonical-workflow-validation.js").CanonicalInformationalWarning[];
  resolvedStatusIds: Partial<Record<CanonicalStatusKey, string>>;
  mergePathVariant: "integration-then-production" | "direct-production";
}

export type ModelSaveReadinessState =
  | "ready"
  | "catalog-unavailable"
  | "invalid-model"
  | "invalid-parameter";

export interface WorkflowRoleModelSaveReadiness {
  role: RoleModelRole;
  ready: boolean;
  state: ModelSaveReadinessState;
  issues: string[];
}

export interface ModelSaveReadiness {
  planner: WorkflowRoleModelSaveReadiness;
  builder: WorkflowRoleModelSaveReadiness;
  planReviewer: WorkflowRoleModelSaveReadiness;
  codeReviewer: WorkflowRoleModelSaveReadiness;
  codeReviser: WorkflowRoleModelSaveReadiness;
  ready: boolean;
}

export interface PlanReviewReadinessView {
  requestedEnabled: boolean;
  effectiveEnabled: boolean;
  uiState: PlanReviewUiState;
  missingRequirementMessages: string[];
  cycleLimit: number;
}

export interface CodeReviewReadinessView {
  requestedEnabled: boolean;
  effectiveEnabled: boolean;
  uiState: CodeReviewUiState;
  missingRequirementMessages: string[];
  cycleLimit: number;
}

export interface WorkflowBootstrapPayload {
  sourceMode: WorkflowSourceMode;
  fixtureId?: string;
  selectedScopeId?: string;
  scopes: WorkflowScope[];
  statuses: WorkflowStatusRecord[];
  currentWorkflowMappings: WorkflowCurrentWorkflowMapping[];
  modelCatalog: WorkflowModelCatalogEntry[];
  catalogLoadMetadata: WorkflowCatalogLoadMetadata;
  plannerSelection: WorkflowModelSelection;
  builderSelection: WorkflowModelSelection;
  planReviewerSelection: WorkflowModelSelection;
  codeReviewerSelection: WorkflowModelSelection;
  codeReviserSelection: WorkflowModelSelection;
  planReviewReadiness: PlanReviewReadinessView;
  codeReviewReadiness: CodeReviewReadinessView;
  configFingerprint: string;
  modelSaveReadiness: ModelSaveReadiness;
  canonicalWorkflow: WorkflowCanonicalWorkflowView;
  warnings: string[];
  debugEnabled?: boolean;
  dataSourceLabel: string;
}
