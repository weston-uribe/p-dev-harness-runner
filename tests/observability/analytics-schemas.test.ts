import { describe, expect, it } from "vitest";
import { parseClientAnalyticsEventBody } from "../../src/observability/analytics-schemas.js";

describe("client analytics schemas", () => {
  it("accepts a valid step viewed payload", () => {
    const parsed = parseClientAnalyticsEventBody({
      type: "p_dev_configure_step_viewed",
      stepId: "connect-services",
      stepNumber: 1,
      resumed: false,
      revisited: false,
    });
    expect(parsed.type).toBe("p_dev_configure_step_viewed");
  });

  it("rejects unknown step ids without echoing submitted values", () => {
    expect(() =>
      parseClientAnalyticsEventBody({
        type: "p_dev_configure_step_viewed",
        stepId: "not-a-real-step",
        stepNumber: 1,
        resumed: false,
        revisited: false,
      }),
    ).toThrow("Invalid analytics event payload.");
  });

  it("rejects mismatched step numbers", () => {
    expect(() =>
      parseClientAnalyticsEventBody({
        type: "p_dev_configure_step_viewed",
        stepId: "connect-services",
        stepNumber: 3,
        resumed: false,
        revisited: false,
      }),
    ).toThrow("Invalid analytics event payload.");
  });

  it("rejects non-fixed resumed and revisited values", () => {
    expect(() =>
      parseClientAnalyticsEventBody({
        type: "p_dev_configure_step_viewed",
        stepId: "connect-services",
        stepNumber: 1,
        resumed: true,
        revisited: false,
      }),
    ).toThrow("Invalid analytics event payload.");
  });

  it("rejects extra properties", () => {
    expect(() =>
      parseClientAnalyticsEventBody({
        type: "p_dev_setup_completed",
        extra: "nope",
      }),
    ).toThrow("Invalid analytics event payload.");
  });

  it("rejects invalid duration buckets", () => {
    expect(() =>
      parseClientAnalyticsEventBody({
        type: "p_dev_configure_step_completed",
        stepId: "connect-services",
        stepNumber: 1,
        resumed: false,
        revisited: false,
        durationBucket: "not-real",
        completionOutcome: "success",
      }),
    ).toThrow("Invalid analytics event payload.");
  });
});
