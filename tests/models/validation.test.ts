import { describe, expect, it } from "vitest";
import {
  assertModelSelectionAccepted,
  ModelParameterValidationError,
} from "../../src/models/index.js";

describe("model selection validation", () => {
  it("accepts explicit Standard and Fast Composer selections", () => {
    expect(() =>
      assertModelSelectionAccepted({
        selection: {
          id: "composer-2.5",
          params: [{ id: "fast", value: "false" }],
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertModelSelectionAccepted({
        selection: {
          id: "composer-2.5",
          params: [{ id: "fast", value: "true" }],
        },
      }),
    ).not.toThrow();
  });

  it("rejects omitted fast for Composer (no silent provider default)", () => {
    expect(() =>
      assertModelSelectionAccepted({
        selection: { id: "composer-2.5", params: [] },
      }),
    ).toThrow(ModelParameterValidationError);
  });

  it("rejects invalid fast values without falling back", () => {
    try {
      assertModelSelectionAccepted({
        selection: {
          id: "composer-2.5",
          params: [{ id: "fast", value: "maybe" }],
        },
      });
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelParameterValidationError);
      const typed = error as ModelParameterValidationError;
      expect(typed.modelId).toBe("composer-2.5");
      expect(typed.parameterId).toBe("fast");
      expect(typed.failureClassification).toBe("invalid_model_parameter_value");
    }
  });

  it("allows models with no parameters", () => {
    expect(() =>
      assertModelSelectionAccepted({
        selection: { id: "unknown-model-without-params" },
      }),
    ).not.toThrow();
  });
});
