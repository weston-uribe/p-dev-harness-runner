import type { ErrorClassification } from "../types/run.js";

export class ProductionSyncProjectionError extends Error {
  readonly classification: NonNullable<ErrorClassification>;
  readonly retryable: boolean;

  constructor(
    classification: NonNullable<ErrorClassification>,
    message: string,
    options?: { retryable?: boolean },
  ) {
    super(message);
    this.name = "ProductionSyncProjectionError";
    this.classification = classification;
    this.retryable = options?.retryable ?? true;
  }
}

export function classifyProductionSyncError(
  error: unknown,
): NonNullable<ErrorClassification> | null {
  if (error instanceof ProductionSyncProjectionError) {
    return error.classification;
  }
  if (
    error &&
    typeof error === "object" &&
    "classification" in error &&
    typeof (error as { classification: unknown }).classification === "string"
  ) {
    return (error as { classification: NonNullable<ErrorClassification> })
      .classification;
  }
  return null;
}
