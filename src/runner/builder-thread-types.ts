export type BuilderThreadAction = "created" | "resumed" | "replaced";

export type BuilderThreadReplacementReason =
  | "legacy_missing_lineage"
  | "agent_not_found"
  | "agent_deleted"
  | "agent_inaccessible";

export type BuilderThreadSourcePhase =
  | "implementation"
  | "revision"
  | "integration_repair";

export interface BuilderThreadReference {
  agentId: string;
  generation: number;
  originHarnessRunId: string;
  latestHarnessRunId: string;
  sourcePhase: BuilderThreadSourcePhase;
  targetRepo: string;
  branch?: string;
  prUrl?: string;
  idempotencyKey?: string;
}

export interface BuilderThreadResolution {
  reference: BuilderThreadReference;
  action: BuilderThreadAction;
  previousAgentId?: string;
  replacementReason?: BuilderThreadReplacementReason;
}

export interface BuilderThreadMarkerEvidence {
  builderAgentId?: string;
  builderThreadGeneration?: number;
  builderThreadAction?: BuilderThreadAction;
  builderOriginRunId?: string;
  builderThreadIdempotencyKey?: string;
  previousBuilderAgentId?: string;
  builderThreadReplacementReason?: BuilderThreadReplacementReason;
}
