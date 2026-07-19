import { z } from "zod";
import {
  DEFAULT_IMPLEMENTATION_BRANCH_PREFIX,
  DEFAULT_LOG_DIRECTORY,
  DEFAULT_ORCHESTRATOR_MARKER,
} from "./defaults.js";
import { roleModelsSchema } from "./role-models.js";
import {
  DEFAULT_CYCLE_LIMITS,
  LEGACY_WORKFLOW_MIGRATION_DEFAULTS,
  WORKFLOW_SCHEMA_VERSION,
} from "../workflow/definition/product-development.v2.js";

const githubRepoUrl = z
  .string()
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/,
    "must be a https://github.com/<owner>/<repo> URL",
  );

export const linearAssociationSchema = z.object({
  workspaceId: z.string().min(1),
  teamId: z.string().min(1),
  teamKey: z.string().min(1),
  /** Full Linear team display name. Optional only for legacy configs; write paths must set it. */
  teamName: z.string().min(1).optional(),
  projectId: z.string().min(1),
  projectName: z.string().min(1),
});

export type LinearAssociation = z.infer<typeof linearAssociationSchema>;

const repoMappingSchema = z.object({
  id: z.string().min(1),
  linearAssociations: z.array(linearAssociationSchema).optional(),
  linearProjects: z.array(z.string()).optional(),
  linearTeams: z.array(z.string()).optional(),
  targetRepo: githubRepoUrl,
  baseBranch: z.string().min(1).default("main"),
  productionBranch: z.string().min(1).default("main"),
  previewProvider: z.string().optional(),
  integrationPreviewUrl: z.string().url().optional(),
  productionUrl: z.string().url().optional(),
  integrationSuccessStatus: z.string().min(1).optional(),
  productionSuccessStatus: z.string().min(1).optional(),
  validation: z
    .object({
      commands: z.array(z.string()).optional(),
    })
    .optional(),
});

const linearConfigSchema = z.object({
  workspaceId: z.string().optional(),
  teamKey: z.string().optional(),
  teamId: z.string().optional(),
  eligibleStatuses: z
    .object({
      planning: z.array(z.string()).optional(),
      implementation: z.array(z.string()).optional(),
      handoff: z.array(z.string()).optional(),
      revision: z.array(z.string()).optional(),
      merge: z.array(z.string()).optional(),
    })
    .optional(),
  transitionalStatuses: z
    .object({
      planningInProgress: z.string().optional(),
      buildingInProgress: z.string().optional(),
      prOpen: z.string().optional(),
      pmReview: z.string().optional(),
      blocked: z.string().optional(),
      readyForBuild: z.string().optional(),
      needsRevision: z.string().optional(),
      revisingInProgress: z.string().optional(),
      readyToMerge: z.string().optional(),
      mergingInProgress: z.string().optional(),
      mergedToDev: z.string().optional(),
      mergedDeployed: z.string().optional(),
    })
    .optional(),
});

const planningConfigSchema = z.object({
  timeoutSeconds: z.number().positive().optional(),
});

const implementationConfigSchema = z.object({
  timeoutSeconds: z.number().positive().optional(),
  branchPrefix: z.string().min(1).default(DEFAULT_IMPLEMENTATION_BRANCH_PREFIX),
});

const handoffConfigSchema = z.object({
  allowPmReviewWithoutPreview: z.boolean().optional(),
  previewRequiredForSuccess: z.boolean().optional(),
});

const revisionConfigSchema = z.object({
  timeoutSeconds: z.number().positive().optional(),
});

const mergeConfigSchema = z.object({
  mergeMethod: z.enum(["squash", "merge", "rebase"]).optional(),
  deleteBranchAfterMerge: z.boolean().optional(),
  allowPendingChecks: z.boolean().optional(),
  allowUnknownChecks: z.boolean().optional(),
  allowNeutralChecks: z.boolean().optional(),
  deploymentRequiredForSuccess: z.boolean().optional(),
  deploymentPollTimeoutSeconds: z.number().positive().optional(),
  deploymentPollIntervalSeconds: z.number().positive().optional(),
  checkPollTimeoutSeconds: z.number().positive().optional(),
});

const agentProviderSchema = z.object({
  id: z.literal("cursor"),
  model: z.object({ id: z.string() }).optional(),
});

const promptProviderConfigSchema = z
  .object({
    provider: z
      .enum(["local", "langfuse_with_local_fallback"])
      .default("local"),
    /** Approved label such as dogfood — never "latest" */
    label: z.string().min(1).optional(),
    version: z.number().int().positive().optional(),
    cacheTtlSeconds: z.number().positive().optional(),
    /**
     * Preferred skill mode. Native execution is not available while Cloud Agent
     * capability is unproven — runtime always renders from .agents/skills.
     */
    preferredSkillMode: z
      .enum(["automatic", "native_when_supported", "rendered_fallback"])
      .default("automatic"),
  })
  .strict()
  .refine(
    (value) =>
      value.label == null || value.label.trim().toLowerCase() !== "latest",
    { message: 'promptProvider.label must not be "latest"' },
  );

const workflowConfigSchema = z
  .object({
    schemaVersion: z.string().min(1).default(WORKFLOW_SCHEMA_VERSION),
    optionalPhases: z
      .object({
        // Zod defaults apply only when the workflow object is present but a
        // field is omitted. Absent workflow sections use LEGACY migration.
        planReview: z
          .boolean()
          .default(LEGACY_WORKFLOW_MIGRATION_DEFAULTS.planReview),
        codeReview: z
          .boolean()
          .default(LEGACY_WORKFLOW_MIGRATION_DEFAULTS.codeReview),
      })
      .strict()
      .default({
        planReview: LEGACY_WORKFLOW_MIGRATION_DEFAULTS.planReview,
        codeReview: LEGACY_WORKFLOW_MIGRATION_DEFAULTS.codeReview,
      }),
    cycleLimits: z
      .object({
        planReview: z
          .number()
          .int()
          .positive()
          .default(DEFAULT_CYCLE_LIMITS.plan_review_cycles),
        codeReview: z
          .number()
          .int()
          .positive()
          .default(DEFAULT_CYCLE_LIMITS.code_review_cycles),
      })
      .strict()
      .default({
        planReview: DEFAULT_CYCLE_LIMITS.plan_review_cycles,
        codeReview: DEFAULT_CYCLE_LIMITS.code_review_cycles,
      }),
  })
  .strict();

export const harnessConfigSchema = z
  .object({
    version: z.literal(1),
    orchestratorMarker: z.string().default(DEFAULT_ORCHESTRATOR_MARKER),
    logDirectory: z.string().default(DEFAULT_LOG_DIRECTORY),
    agentProvider: agentProviderSchema.optional(),
    defaultModel: z.object({ id: z.string() }).optional(),
    roleModels: roleModelsSchema.optional(),
    promptProvider: promptProviderConfigSchema.optional(),
    /**
     * Versioned workflow knobs. New workspaces persist reviews on via the
     * config builder; legacy configs without this section migrate to off.
     */
    workflow: workflowConfigSchema.optional(),
    /**
     * Issue-scoped validation-run snapshots for dogfood/synthetic gates.
     * Never enables shared workflow.optionalPhases; cloud-syncable for managed runners.
     */
    validationRuns: z.array(z.record(z.unknown())).optional(),
    linear: linearConfigSchema.optional(),
    planning: planningConfigSchema.optional(),
    implementation: implementationConfigSchema.optional(),
    handoff: handoffConfigSchema.optional(),
    revision: revisionConfigSchema.optional(),
    merge: mergeConfigSchema.optional(),
    watch: z
      .object({
        pollIntervalSeconds: z.number().positive().optional(),
        maxConcurrentRuns: z.number().positive().optional(),
      })
      .optional(),
    preview: z
      .object({
        pollTimeoutSeconds: z.number().positive().optional(),
        pollIntervalSeconds: z.number().positive().optional(),
      })
      .optional(),
    repos: z.array(repoMappingSchema).min(1),
    allowedTargetRepos: z.array(githubRepoUrl).min(1),
  })
  .strict();

export type HarnessConfig = z.infer<typeof harnessConfigSchema>;
export type RepoMapping = z.infer<typeof repoMappingSchema>;
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;
