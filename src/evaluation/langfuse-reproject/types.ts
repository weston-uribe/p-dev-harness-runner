export const REPROJECTION_SCHEMA_VERSION = 1 as const;

export interface ReprojectChange {
  action: "create_trace" | "create_observation" | "create_score" | "skip" | "update_metadata";
  entityType: "trace" | "observation" | "score" | "session";
  name: string;
  reason: string;
  sourceArtifactHashes?: string[];
}

export interface ReprojectReport {
  schemaVersion: typeof REPROJECTION_SCHEMA_VERSION;
  issueKey: string;
  namespace: string;
  sessionId: string;
  mode: "dry-run" | "apply";
  reprojected: boolean;
  changes: ReprojectChange[];
  sourceArtifactHashes: string[];
  validationProjectionUsed: boolean;
  acceptanceComplete: boolean;
  inspectedAt: string;
}
