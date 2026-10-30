import {
  AgentNotFoundError,
  AuthenticationError,
  CursorAgentError,
  NetworkError,
  RateLimitError,
  type SDKAgent,
} from "@cursor/sdk";
import type { EventLogger } from "../artifacts/events.js";
import {
  createImplementationCloudAgent,
  createReplacementBuilderCloudAgent,
  resumeBuilderCloudAgent,
} from "../cursor/agent-factory.js";
import { classifyBuilderResumeError } from "../cursor/builder-resume-errors.js";
import type { HarnessConfig } from "../config/types.js";
import type { LinearCommentRecord } from "../linear/writer.js";
import {
  BuilderThreadLineageError,
  resolveBuilderThreadReference,
} from "./builder-thread-lineage.js";
import type {
  BuilderThreadReference,
  BuilderThreadReplacementReason,
  BuilderThreadResolution,
  BuilderThreadSourcePhase,
} from "./builder-thread-types.js";

export interface AcquireBuilderAgentContext {
  issueKey: string;
  harnessRunId: string;
  targetRepo: string;
  baseBranch: string;
  branch?: string;
  prUrl?: string;
  idempotencyKey: string;
  comments: LinearCommentRecord[];
  orchestratorMarker: string;
  previousImplementationRunId?: string;
  previousRevisionRunId?: string;
  workflowState?: {
    builderAgentId?: string | null;
    builderRunId?: string | null;
    issueKey?: string;
  } | null;
}

/**
 * Optional for tests/nonproduction. Production LinearHarnessAgentProvider
 * always supplies a mandatory provenance adapter — never rely on no-op absence.
 */
export interface BuilderProvenanceMutationHooks {
  beforeMutation(info: {
    action: "create" | "resume" | "replacement";
    generation: number;
    priorAgentId?: string;
  }): Promise<void>;
  afterAgent(info: {
    action: "create" | "resume" | "replacement";
    agentId: string;
    generation: number;
    priorAgentId?: string;
  }): Promise<void>;
  onMutationFailed?(info: {
    action: "create" | "resume" | "replacement";
    error: unknown;
  }): Promise<void>;
}

export interface AcquireBuilderAgentParams {
  apiKey: string;
  config: HarnessConfig;
  phase: BuilderThreadSourcePhase;
  context: AcquireBuilderAgentContext;
  events: EventLogger;
  /** Generic optional extension; production path supplies a mandatory adapter. */
  provenanceHooks?: BuilderProvenanceMutationHooks;
}

export interface AcquiredBuilderAgent {
  agent: SDKAgent;
  continuity: BuilderThreadResolution;
}

export interface ReplacementBuilderContext extends AcquireBuilderAgentContext {
  replacementReason: BuilderThreadReplacementReason;
  previousAgentId?: string;
  priorGeneration?: number;
}

function wrapReference(
  reference: BuilderThreadReference,
  action: BuilderThreadResolution["action"],
  extra?: Partial<BuilderThreadResolution>,
): BuilderThreadResolution {
  return {
    reference,
    action,
    ...extra,
  };
}

async function createInitialBuilder(
  params: AcquireBuilderAgentParams,
): Promise<AcquiredBuilderAgent> {
  const { apiKey, config, context } = params;
  const hooks = params.provenanceHooks;
  try {
    await hooks?.beforeMutation({ action: "create", generation: 1 });
    const agent = await createImplementationCloudAgent({
      apiKey,
      config,
      targetRepo: context.targetRepo,
      baseBranch: context.baseBranch,
    });
    await hooks?.afterAgent({
      action: "create",
      agentId: agent.agentId,
      generation: 1,
    });
    const reference: BuilderThreadReference = {
      agentId: agent.agentId,
      generation: 1,
      originHarnessRunId: context.harnessRunId,
      latestHarnessRunId: context.harnessRunId,
      sourcePhase: params.phase,
      targetRepo: context.targetRepo,
      branch: context.branch,
      prUrl: context.prUrl,
      idempotencyKey: context.idempotencyKey,
    };
    await params.events.log("builder_thread_created", "info", {
      agentId: agent.agentId,
      generation: 1,
      phase: params.phase,
    });
    return {
      agent,
      continuity: wrapReference(reference, "created"),
    };
  } catch (error) {
    await hooks?.onMutationFailed?.({ action: "create", error });
    throw error;
  }
}

async function resumeExistingBuilder(
  params: AcquireBuilderAgentParams,
  prior: BuilderThreadReference,
): Promise<AcquiredBuilderAgent> {
  await params.events.log("builder_thread_resume_attempted", "info", {
    agentId: prior.agentId,
    generation: prior.generation,
    phase: params.phase,
  });
  const hooks = params.provenanceHooks;
  try {
    await hooks?.beforeMutation({
      action: "resume",
      generation: prior.generation,
      priorAgentId: prior.agentId,
    });
    const agent = await resumeBuilderCloudAgent({
      apiKey: params.apiKey,
      agentId: prior.agentId,
      events: params.events,
    });
    await hooks?.afterAgent({
      action: "resume",
      agentId: agent.agentId,
      generation: prior.generation,
      priorAgentId: prior.agentId,
    });
    const reference: BuilderThreadReference = {
      ...prior,
      latestHarnessRunId: params.context.harnessRunId,
      sourcePhase: params.phase,
      branch: params.context.branch ?? prior.branch,
      prUrl: params.context.prUrl ?? prior.prUrl,
      idempotencyKey: params.context.idempotencyKey,
    };
    await params.events.log("builder_thread_resumed", "info", {
      agentId: agent.agentId,
      generation: reference.generation,
      phase: params.phase,
    });
    return {
      agent,
      continuity: wrapReference(reference, "resumed"),
    };
  } catch (error) {
    await hooks?.onMutationFailed?.({ action: "resume", error });
    await params.events.log("builder_thread_resume_failed", "warn", {
      agentId: prior.agentId,
      classification: classifyBuilderResumeError(error),
    });
    throw error;
  }
}

function resolvePriorReference(
  params: AcquireBuilderAgentParams,
): BuilderThreadReference | null {
  try {
    return resolveBuilderThreadReference({
      comments: params.context.comments,
      orchestratorMarker: params.context.orchestratorMarker,
      issueKey: params.context.issueKey,
      targetRepo: params.context.targetRepo,
      branch: params.context.branch,
      prUrl: params.context.prUrl,
      previousImplementationRunId: params.context.previousImplementationRunId,
      previousRevisionRunId: params.context.previousRevisionRunId,
      workflowState: params.context.workflowState,
    });
  } catch (error) {
    if (error instanceof BuilderThreadLineageError) {
      void params.events.log("builder_thread_lineage_rejected", "error", {
        phase: params.phase,
        reason: error.reason,
        ...error.details,
      });
    }
    throw error;
  }
}

function assertReplacementPrLineage(
  params: AcquireBuilderAgentParams,
  context: ReplacementBuilderContext,
): asserts context is ReplacementBuilderContext & {
  branch: string;
  prUrl: string;
} {
  if (params.phase === "implementation") {
    return;
  }
  if (!context.branch || !context.prUrl) {
    throw new BuilderThreadLineageError(
      "missing_pr_lineage",
      "Revision and integration-repair replacement requires an existing PR branch and prUrl",
      {
        phase: params.phase,
        branch: context.branch,
        prUrl: context.prUrl,
        replacementReason: context.replacementReason,
      },
    );
  }
}

export async function acquireBuilderAgent(
  params: AcquireBuilderAgentParams,
): Promise<AcquiredBuilderAgent> {
  const prior = resolvePriorReference(params);

  if (prior) {
    await params.events.log("builder_thread_resolved", "info", {
      agentId: prior.agentId,
      generation: prior.generation,
      phase: params.phase,
    });
    try {
      return await resumeExistingBuilder(params, prior);
    } catch (error) {
      const replacementReason = classifyBuilderResumeError(error);
      if (!replacementReason) {
        throw error;
      }
      return createReplacementBuilderAgent({
        ...params,
        context: {
          ...params.context,
          replacementReason,
          previousAgentId: prior.agentId,
          priorGeneration: prior.generation,
        },
      });
    }
  }

  if (params.phase === "implementation") {
    return createInitialBuilder(params);
  }

  await params.events.log("builder_thread_lineage_rejected", "error", {
    phase: params.phase,
    reason: "legacy_missing_lineage",
  });
  return createReplacementBuilderAgent({
    ...params,
    context: {
      ...params.context,
      replacementReason: "legacy_missing_lineage",
    },
  });
}

export async function createReplacementBuilderAgent(
  params: AcquireBuilderAgentParams & {
    context: ReplacementBuilderContext;
  },
): Promise<AcquiredBuilderAgent> {
  const { apiKey, config, context } = params;
  assertReplacementPrLineage(params, context);

  const priorGeneration = context.priorGeneration ?? 0;
  const generation = Math.max(1, priorGeneration + 1);
  const hooks = params.provenanceHooks;
  try {
    await hooks?.beforeMutation({
      action: "replacement",
      generation,
      priorAgentId: context.previousAgentId,
    });
    const agent =
      params.phase === "implementation"
        ? await createImplementationCloudAgent({
            apiKey,
            config,
            targetRepo: context.targetRepo,
            baseBranch: context.baseBranch,
          })
        : await createReplacementBuilderCloudAgent({
            apiKey,
            config,
            targetRepo: context.targetRepo,
            branch: context.branch,
            prUrl: context.prUrl,
          });
    await hooks?.afterAgent({
      action: "replacement",
      agentId: agent.agentId,
      generation,
      priorAgentId: context.previousAgentId,
    });
    const reference: BuilderThreadReference = {
      agentId: agent.agentId,
      generation,
      originHarnessRunId: context.harnessRunId,
      latestHarnessRunId: context.harnessRunId,
      sourcePhase: params.phase,
      targetRepo: context.targetRepo,
      branch: context.branch,
      prUrl: context.prUrl,
      idempotencyKey: context.idempotencyKey,
    };
    await params.events.log("builder_thread_replacement_created", "info", {
      agentId: agent.agentId,
      generation: reference.generation,
      replacementReason: context.replacementReason,
      previousAgentId: context.previousAgentId,
    });
    return {
      agent,
      continuity: wrapReference(reference, "replaced", {
        previousAgentId: context.previousAgentId,
        replacementReason: context.replacementReason,
      }),
    };
  } catch (error) {
    await hooks?.onMutationFailed?.({ action: "replacement", error });
    throw error;
  }
}

export function isTransientBuilderResumeError(error: unknown): boolean {
  return (
    error instanceof AuthenticationError ||
    error instanceof NetworkError ||
    error instanceof RateLimitError ||
    (error instanceof CursorAgentError && error.isRetryable)
  );
}

export function isDefinitiveAgentLossError(
  error: unknown,
): BuilderThreadReplacementReason | null {
  if (error instanceof AgentNotFoundError) {
    return "agent_not_found";
  }
  if (error instanceof CursorAgentError) {
    if (error.code === "agent_not_found") {
      return "agent_not_found";
    }
    if (error.code === "agent_deleted") {
      return "agent_deleted";
    }
    if (error.code === "agent_inaccessible") {
      return "agent_inaccessible";
    }
  }
  return classifyBuilderResumeError(error);
}
