export const SYNTHETIC_PROJECTION_CANARY_SCHEMA_VERSION = 1 as const;

export interface SyntheticProjectionCanaryReport {
  schemaVersion: typeof SYNTHETIC_PROJECTION_CANARY_SCHEMA_VERSION;
  mode: "dry-run" | "apply";
  issueKey: string;
  namespace: string;
  sessionId: string;
  captureProfile: string;
  contentBodiesEnabled: boolean;
  privacyGatePassed: boolean;
  privacyGateReason: string | null;
  configNamesPresent: {
    langfusePublicKey: boolean;
    langfuseSecretKey: boolean;
    langfuseBaseUrl: boolean;
    langfuseTracingEnvironment: boolean;
    evaluationProvider: boolean;
    evaluationCaptureProfile: boolean;
    evaluationNamespace: boolean;
  };
  projected: {
    sessionDisplayName: string;
    phaseTraceName: string;
    agentName: string;
    generationName: string;
    skillProvenanceStatus: "present" | "none";
    costSource: string;
    costUnavailableReason: string | null;
    costUsd?: number | null;
    effectiveVariant?: "standard" | "fast" | "none";
  };
  applied: boolean;
  acceptanceComplete: boolean | null;
  inspectedAt: string;
}
