/** Bounded numeric TokenUsage shape from @cursor/sdk@1.0.23 (no content). */
export interface BoundedTokenUsageShape {
  present: boolean;
  inputTokensPresent: boolean;
  outputTokensPresent: boolean;
  cacheReadTokensPresent: boolean;
  cacheWriteTokensPresent: boolean;
  totalTokensPresent: boolean;
  reasoningTokensPresent: boolean;
  /** Numeric values for private analysis only — never log to public Actions. */
  values?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
}

export interface StreamUsageEventFact {
  type: "usage";
  /** Identity keys present on the SDK message (names only). */
  identityKeys: string[];
  usagePropertyNames: string[];
  usage: BoundedTokenUsageShape;
}

export interface RuntimeProbeEvidence {
  runtime: "cloud" | "local";
  attempted: boolean;
  blockedReason: string | null;
  sdkPackageVersion: string;
  agentIdPresent: boolean;
  runIdPresent: boolean;
  requestIdPresent: boolean;
  streamCompletionClean: boolean;
  streamEventTypeNames: string[];
  streamUsageEventCount: number;
  streamUsageEvents: StreamUsageEventFact[];
  /** Whether streamed usage values appear incremental across events (private heuristic). */
  streamedUsageLooksIncremental: boolean | null;
  /** Whether streamed usage values appear non-decreasing cumulative (private heuristic). */
  streamedUsageLooksCumulative: boolean | null;
  stableStreamUsageIdentityPresent: boolean;
  terminalUsage: BoundedTokenUsageShape;
  runHandleUsageAfterWait: BoundedTokenUsageShape;
  terminalAndHandleAgreeOnInputOutput: boolean | null;
  /** Heuristic: inputTokens vs cache fields relationship. */
  inputTokensVsCacheHypothesis:
    | "unknown"
    | "cache_absent"
    | "input_likely_includes_cache"
    | "input_likely_excludes_cache"
    | "inconclusive";
  authoritativeCumulativePresent: boolean;
  goNoGo: "go" | "no-go";
  goNoGoReason: string;
}

export interface CursorSdkUsageProbePublicSummary {
  schemaVersion: 1;
  kind: "cursor_sdk_usage_probe_public";
  sdkPackageVersion: string;
  cloudAttempted: boolean;
  localAttempted: boolean;
  usageEventObserved: boolean;
  terminalUsageObserved: boolean;
  runHandleUsageObserved: boolean;
  inputTokenFieldPresent: boolean;
  outputTokenFieldPresent: boolean;
  streamCompletionClean: boolean;
  stableStreamUsageIdentityPresent: boolean;
  authoritativeCumulativePresent: boolean;
  goNoGo: "go" | "no-go";
}

export interface CursorSdkUsageProbeReport {
  schemaVersion: 1;
  kind: "cursor_sdk_usage_probe_private";
  preparedAt: string;
  sdkPackageVersion: string;
  lockfileResolvedVersion: string;
  cloud: RuntimeProbeEvidence;
  local: RuntimeProbeEvidence | null;
  cloudVsLocalShapeNotes: string[];
  publicSummary: CursorSdkUsageProbePublicSummary;
  notes: string[];
}
