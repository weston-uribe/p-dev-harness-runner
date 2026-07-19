import { describe, expect, it } from "vitest";
import {
  classifyUnexpectedPhaseError,
  isStaleEligibilitySkip,
  isWrongStatusError,
} from "../../src/runner/classify-phase-error.js";
import { PlanningError } from "../../src/runner/errors.js";

describe("classify-phase-error", () => {
  it("detects wrong_status errors", () => {
    expect(
      isWrongStatusError(
        new PlanningError(
          "wrong_status",
          'wrong_status: issue is "Blocked"; expected one of: Ready for Planning',
        ),
      ),
    ).toBe(true);
    expect(
      isWrongStatusError(
        new Error('wrong_status: issue is "Blocked"; expected one of: Ready for Planning'),
      ),
    ).toBe(true);
  });

  it("treats pre-claim wrong_status as stale eligibility skip", () => {
    const error = new PlanningError(
      "wrong_status",
      'wrong_status: issue is "Blocked"; expected one of: Ready for Planning',
    );
    expect(isStaleEligibilitySkip(error, false)).toBe(true);
    expect(isStaleEligibilitySkip(error, true)).toBe(false);
  });

  it("classifies Linear write failures narrowly", () => {
    expect(
      classifyUnexpectedPhaseError(new Error("Failed to transition issue to Planning")),
    ).toBe("linear_write_failure");
    expect(
      classifyUnexpectedPhaseError(
        new Error('Workflow state "Planning" not found for team team-1'),
      ),
    ).toBe("linear_write_failure");
    expect(classifyUnexpectedPhaseError(new Error("Cursor agent create failed"))).toBe(
      "cursor_api_failure",
    );
    expect(classifyUnexpectedPhaseError(new Error("unexpected boom"))).toBe(
      "validation_failed",
    );
  });
});
