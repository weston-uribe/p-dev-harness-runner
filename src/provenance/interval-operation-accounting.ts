/**
 * Pure interval operation accounting for operator finalize diagnostics.
 */

export type DispatchSourceKind =
  | "linear_issue"
  | "github_workflow_dispatch"
  | "github_workflow_run"
  | "cursor_cloud_agent"
  | "unknown";

export interface ConfiguredDispatchSource {
  sourceKind: DispatchSourceKind;
  sourceId: string;
  activityStartInclusive: string;
  activityEndExclusive: string | null;
  metadata?: Record<string, string>;
}

export interface OverlappingOperationRef {
  operationId: string;
  sourceKind: DispatchSourceKind;
  activityStartInclusive: string;
  activityEndExclusive: string | null;
  terminalStatus: "success" | "failure" | "active" | "unknown";
}

export type IntervalOperationClassification =
  | "fully_captured"
  | "unresolved"
  | "unrelated";

export interface IntervalOperationAccountingInput {
  intervalStart: string;
  intervalEnd: string;
  configuredSources: ConfiguredDispatchSource[];
  overlappingOperations: OverlappingOperationRef[];
  capturedOperationIds: ReadonlySet<string>;
}

export interface IntervalOperationAccountingRow {
  operation: OverlappingOperationRef;
  classification: IntervalOperationClassification;
  reasonCode: string | null;
}

export interface IntervalOperationAccountingResult {
  rows: IntervalOperationAccountingRow[];
  fullyCapturedCount: number;
  unresolvedCount: number;
  unrelatedCount: number;
}

function parseIso(value: string): number {
  return Date.parse(value);
}

function overlapsInterval(
  opStart: string,
  opEnd: string | null,
  intervalStart: string,
  intervalEnd: string,
): boolean {
  const start = parseIso(opStart);
  const end = opEnd ? parseIso(opEnd) : Number.POSITIVE_INFINITY;
  const iStart = parseIso(intervalStart);
  const iEnd = parseIso(intervalEnd);
  return start < iEnd && end > iStart;
}

export function classifyIntervalOperation(input: {
  operation: OverlappingOperationRef;
  intervalStart: string;
  intervalEnd: string;
  capturedOperationIds: ReadonlySet<string>;
}): IntervalOperationAccountingRow {
  const { operation, intervalStart, intervalEnd, capturedOperationIds } = input;
  if (
    !overlapsInterval(
      operation.activityStartInclusive,
      operation.activityEndExclusive,
      intervalStart,
      intervalEnd,
    )
  ) {
    return {
      operation,
      classification: "unrelated",
      reasonCode: "outside_interval",
    };
  }

  if (capturedOperationIds.has(operation.operationId)) {
    return {
      operation,
      classification: "fully_captured",
      reasonCode: null,
    };
  }

  if (operation.terminalStatus === "active") {
    return {
      operation,
      classification: "unresolved",
      reasonCode: "active_operation_not_captured",
    };
  }

  return {
    operation,
    classification: "unresolved",
    reasonCode: "operation_not_in_registry",
  };
}

export function accountIntervalOperations(
  input: IntervalOperationAccountingInput,
): IntervalOperationAccountingResult {
  const rows = input.overlappingOperations.map((operation) =>
    classifyIntervalOperation({
      operation,
      intervalStart: input.intervalStart,
      intervalEnd: input.intervalEnd,
      capturedOperationIds: input.capturedOperationIds,
    }),
  );

  let fullyCapturedCount = 0;
  let unresolvedCount = 0;
  let unrelatedCount = 0;
  for (const row of rows) {
    if (row.classification === "fully_captured") fullyCapturedCount += 1;
    if (row.classification === "unresolved") unresolvedCount += 1;
    if (row.classification === "unrelated") unrelatedCount += 1;
  }

  return {
    rows,
    fullyCapturedCount,
    unresolvedCount,
    unrelatedCount,
  };
}

export function configuredSourcesOverlappingInterval(
  sources: ConfiguredDispatchSource[],
  intervalStart: string,
  intervalEnd: string,
): ConfiguredDispatchSource[] {
  return sources.filter((source) =>
    overlapsInterval(
      source.activityStartInclusive,
      source.activityEndExclusive,
      intervalStart,
      intervalEnd,
    ),
  );
}
