import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hasStatusChange,
  parseLinearIssueEvent,
} from "../../src/webhook/parse-linear-issue-event.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/webhook",
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
}

describe("parseLinearIssueEvent", () => {
  it("parses an issue status update", () => {
    const payload = loadFixture("issue-ready-for-planning.json");
    const parsed = parseLinearIssueEvent(
      payload,
      {
        signature: null,
        deliveryId: "delivery-1",
        eventType: "Issue",
        timestamp: "1700000000000",
      },
      "WES",
    );

    expect(parsed).toMatchObject({
      issueKey: "WES-20",
      action: "update",
      statusName: "Ready for Planning",
      previousStatusName: "Backlog",
      statusChanged: true,
      eventType: "Issue",
      linearDeliveryId: "delivery-1",
      actorSummary: "Weston Uribe",
    });
  });

  it("parses create events", () => {
    const payload = {
      action: "create",
      type: "Issue",
      webhookId: "wh-1",
      data: {
        id: "id-1",
        identifier: "WES-99",
        state: { name: "Ready for Build" },
      },
    };

    const parsed = parseLinearIssueEvent(payload, {
      signature: null,
      deliveryId: null,
      eventType: "Issue",
      timestamp: null,
    });

    expect(parsed?.action).toBe("create");
    expect(parsed?.statusName).toBe("Ready for Build");
    expect(parsed?.statusChanged).toBe(false);
  });

  it("returns null for invalid payloads", () => {
    expect(
      parseLinearIssueEvent(null, {
        signature: null,
        deliveryId: null,
        eventType: null,
        timestamp: null,
      }),
    ).toBeNull();
  });

  it("detects status changes from updatedFrom.stateId", () => {
    const payload = loadFixture("issue-building-to-pr-open.json");
    expect(hasStatusChange(payload as Record<string, unknown>)).toBe(true);
  });

  it("does not treat title-only updates as status changes", () => {
    const payload = loadFixture("issue-title-only-update.json");
    expect(hasStatusChange(payload as Record<string, unknown>)).toBe(false);
  });
});
