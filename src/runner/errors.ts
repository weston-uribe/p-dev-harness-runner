import type { CursorCancelOutcome } from "../agents/types.js";

export class PhaseError extends Error {
  readonly classification: import("../types/run.js").ErrorClassification;
  readonly cancelOutcome: CursorCancelOutcome | null;

  constructor(
    classification: NonNullable<import("../types/run.js").ErrorClassification>,
    message: string,
    cancelOutcome: CursorCancelOutcome | null = null,
  ) {
    super(message);
    this.name = "PhaseError";
    this.classification = classification;
    this.cancelOutcome = cancelOutcome;
  }
}

export class PlanningError extends PhaseError {
  constructor(
    classification: NonNullable<import("../types/run.js").ErrorClassification>,
    message: string,
    cancelOutcome: CursorCancelOutcome | null = null,
  ) {
    super(classification, message, cancelOutcome);
    this.name = "PlanningError";
  }
}

export class PlanReviewError extends PhaseError {
  constructor(
    classification: NonNullable<import("../types/run.js").ErrorClassification>,
    message: string,
    cancelOutcome: CursorCancelOutcome | null = null,
  ) {
    super(classification, message, cancelOutcome);
    this.name = "PlanReviewError";
  }
}

export class CodeReviewError extends PhaseError {
  constructor(
    classification: NonNullable<import("../types/run.js").ErrorClassification>,
    message: string,
    cancelOutcome: CursorCancelOutcome | null = null,
  ) {
    super(classification, message, cancelOutcome);
    this.name = "CodeReviewError";
  }
}

export class CodeRevisionError extends PhaseError {
  constructor(
    classification: NonNullable<import("../types/run.js").ErrorClassification>,
    message: string,
    cancelOutcome: CursorCancelOutcome | null = null,
  ) {
    super(classification, message, cancelOutcome);
    this.name = "CodeRevisionError";
  }
}

export class ImplementationError extends PhaseError {
  constructor(
    classification: NonNullable<import("../types/run.js").ErrorClassification>,
    message: string,
    cancelOutcome: CursorCancelOutcome | null = null,
  ) {
    super(classification, message, cancelOutcome);
    this.name = "ImplementationError";
  }
}

export class HandoffError extends PhaseError {
  constructor(
    classification: NonNullable<import("../types/run.js").ErrorClassification>,
    message: string,
  ) {
    super(classification, message, null);
    this.name = "HandoffError";
  }
}

export class RevisionError extends PhaseError {
  constructor(
    classification: NonNullable<import("../types/run.js").ErrorClassification>,
    message: string,
    cancelOutcome: CursorCancelOutcome | null = null,
  ) {
    super(classification, message, cancelOutcome);
    this.name = "RevisionError";
  }
}

export class MergeError extends PhaseError {
  constructor(
    classification: NonNullable<import("../types/run.js").ErrorClassification>,
    message: string,
  ) {
    super(classification, message, null);
    this.name = "MergeError";
  }
}
