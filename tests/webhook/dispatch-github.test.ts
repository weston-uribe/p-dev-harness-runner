import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildRepositoryDispatchUrl,
  dispatchRepositoryEvent,
} from "../../src/webhook/dispatch-github.js";
import { handleLinearWebhook } from "../../src/webhook/handle-linear-webhook.js";
import {
  buildHarnessRunArgs,
  buildHarnessRunCommand,
} from "../../src/webhook/workflow-command.js";

const SECRET = "test-webhook-secret";
const TOKEN = "ghp_test_token";

function signBody(rawBody: string): string {
  return createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

describe("dispatchRepositoryEvent", () => {
  it("posts repository_dispatch with expected payload", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    await dispatchRepositoryEvent({
      token: TOKEN,
      repository: "weston-uribe/agentic-product-development-harness",
      eventType: "linear_issue_status_changed",
      clientPayload: {
        issueKey: "WES-20",
        issueId: "id-1",
        issueUrl: "https://linear.app/weston/issue/WES-20/test",
        action: "update",
        statusName: "Ready for Planning",
        previousStatusName: "Backlog",
        linearDeliveryId: "delivery-1",
        linearWebhookId: "webhook-1",
        receivedAt: "2026-07-07T17:50:00.000Z",
      },
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      buildRepositoryDispatchUrl("weston-uribe/agentic-product-development-harness"),
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
    });

    const body = JSON.parse(String(init.body));
    expect(body.event_type).toBe("linear_issue_status_changed");
    expect(body.client_payload.issueKey).toBe("WES-20");
  });

  it("posts production_promoted repository_dispatch payload", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    await dispatchRepositoryEvent({
      token: TOKEN,
      repository: "weston-uribe/agentic-product-development-harness",
      eventType: "production_promoted",
      clientPayload: {
        repo: "target-app",
        productionBranch: "main",
        sourceRepo: "owner/example-target-app",
        after: "abc123def456",
        ref: "refs/heads/main",
        receivedAt: "2026-07-07T23:46:00.000Z",
        githubRunId: "12345",
      },
      fetchImpl: fetchMock,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.event_type).toBe("production_promoted");
    expect(body.client_payload.repo).toBe("target-app");
    expect(body.client_payload.productionBranch).toBe("main");
    expect(body.client_payload.after).toBe("abc123def456");
  });

  it("throws when GitHub dispatch fails", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));

    await expect(
      dispatchRepositoryEvent({
        token: TOKEN,
        repository: "weston-uribe/agentic-product-development-harness",
        eventType: "linear_issue_status_changed",
        clientPayload: {
          issueKey: "WES-20",
          issueId: null,
          issueUrl: null,
          action: "update",
          statusName: "Ready for Planning",
          previousStatusName: null,
          linearDeliveryId: null,
          linearWebhookId: null,
          receivedAt: "2026-07-07T17:50:00.000Z",
        },
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/repository_dispatch failed/);
  });
});

describe("handleLinearWebhook integration", () => {
  it("dispatches for allowlisted status changes", async () => {
    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/webhook/issue-ready-for-planning.json",
    );
    const rawBody = readFileSync(fixturePath, "utf8");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    const envelopeDispatch = vi.fn(async () => ({
      requestId: "11111111-1111-4111-8111-111111111111",
      envelopeSchemaVersion: 1,
      publicEventType: "linear_issue_status_changed",
      executionRepository: "owner/execution-repo",
      dispatched: true,
      duplicate: false,
      ackConfirmed: true,
    }));

    const result = await handleLinearWebhook({
      method: "POST",
      rawBody,
      headerGetter: (name) => {
        if (name === "linear-signature") return signBody(rawBody);
        if (name === "linear-delivery") return "delivery-1";
        if (name === "linear-event") return "Issue";
        if (name === "linear-timestamp") return "1700000000000";
        return null;
      },
      webhookSecret: SECRET,
      dispatchToken: TOKEN,
      nowMs: 1_700_000_000_000,
      fetchImpl: fetchMock,
      envelopeDispatch,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      accepted: true,
      dispatched: true,
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    expect(envelopeDispatch).toHaveBeenCalledOnce();
    expect(envelopeDispatch.mock.calls[0]?.[0]).toMatchObject({
      issueKey: "WES-20",
      dispatchToken: TOKEN,
      ackRequired: false,
    });
  });

  it("returns ignored_status without dispatching", async () => {
    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/webhook/issue-pm-review.json",
    );
    const rawBody = readFileSync(fixturePath, "utf8");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await handleLinearWebhook({
      method: "POST",
      rawBody,
      headerGetter: (name) => {
        if (name === "linear-signature") return signBody(rawBody);
        if (name === "linear-delivery") return "delivery-2";
        if (name === "linear-event") return "Issue";
        if (name === "linear-timestamp") return "1700000000000";
        return null;
      },
      webhookSecret: SECRET,
      dispatchToken: TOKEN,
      nowMs: 1_700_000_000_000,
      fetchImpl: fetchMock,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ accepted: false, reason: "ignored_status" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("workflow command construction", () => {
  it("builds repository_dispatch harness command", () => {
    expect(buildHarnessRunCommand("WES-20")).toBe(
      "npm run harness:run -- --issue WES-20 --phase auto --json",
    );
  });

  it("builds manual workflow_dispatch args", () => {
    expect(buildHarnessRunArgs("WES-20", "planning")).toEqual([
      "run",
      "--issue",
      "WES-20",
      "--phase",
      "planning",
      "--json",
    ]);
  });
});
