import { describe, expect, it } from "vitest";
import {
  accountIntervalOperations,
  classifyIntervalOperation,
} from "../../src/provenance/interval-operation-accounting.js";

describe("interval operation accounting", () => {
  it("classifies captured operations as fully_captured", () => {
    const row = classifyIntervalOperation({
      operation: {
        operationId: "op-1",
        sourceKind: "linear_issue",
        activityStartInclusive: "2026-07-10T10:00:00.000Z",
        activityEndExclusive: "2026-07-10T11:00:00.000Z",
        terminalStatus: "success",
      },
      intervalStart: "2026-07-10T00:00:00.000Z",
      intervalEnd: "2026-07-11T00:00:00.000Z",
      capturedOperationIds: new Set(["op-1"]),
    });
    expect(row.classification).toBe("fully_captured");
  });

  it("classifies missing registry ops as unresolved", () => {
    const result = accountIntervalOperations({
      intervalStart: "2026-07-10T00:00:00.000Z",
      intervalEnd: "2026-07-11T00:00:00.000Z",
      configuredSources: [],
      overlappingOperations: [
        {
          operationId: "op-missing",
          sourceKind: "github_workflow_run",
          activityStartInclusive: "2026-07-10T10:00:00.000Z",
          activityEndExclusive: "2026-07-10T11:00:00.000Z",
          terminalStatus: "failure",
        },
      ],
      capturedOperationIds: new Set(),
    });
    expect(result.unresolvedCount).toBe(1);
    expect(result.fullyCapturedCount).toBe(0);
  });
});
