import { describe, expect, it } from "vitest";
import { buildJobRequestRecord } from "../../src/workflow/job-request/create.js";
import { resolveJobRequestId } from "../../src/workflow/job-request/request-id.js";

describe("job request ack + delivery identity", () => {
  it("uses deterministic request ids for Linear deliveries", () => {
    const a = resolveJobRequestId({ linearDeliveryId: "delivery-1" });
    const b = resolveJobRequestId({ linearDeliveryId: "delivery-1" });
    const c = resolveJobRequestId({ linearDeliveryId: "delivery-2" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("dlv-")).toBe(true);
  });

  it("persists ack-required lifecycle fields on create", () => {
    const record = buildJobRequestRecord({
      issueKey: "FRE-1",
      phase: "auto",
      triggerSource: "linear_issue_status",
      linearDeliveryId: "delivery-ack",
    });
    expect(record.ack?.ackRequired).toBe(true);
    expect(record.ack?.acceptedAt).toBe(record.createdAt);
    expect(record.ack?.ackConfirmedAt).toBeNull();
    expect(record.ack?.ackSource).toBeNull();
    expect(record.requestId).toBe(
      resolveJobRequestId({ linearDeliveryId: "delivery-ack" }),
    );
  });

  it("can create harness-owned code_review jobs without ack", () => {
    const record = buildJobRequestRecord({
      issueKey: "FRE-1",
      phase: "code_review",
      triggerSource: "harness_code_review_handoff",
      linearDeliveryId: "cr-subject:abc",
      reviewSubjectIdentity: "abc",
      ackRequired: false,
    });
    expect(record.ack?.ackRequired).toBe(false);
    expect(record.reviewSubjectIdentity).toBe("abc");
    expect(record.phase).toBe("code_review");
  });
});
