import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { buildVercelBridgeArtifactFiles } from "../../src/setup/vercel-bridge-artifact.js";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function buildIssuePayload(issueKey: string, statusName: string): string {
  return JSON.stringify({
    type: "Issue",
    action: "update",
    webhookTimestamp: Date.now(),
    data: {
      identifier: issueKey,
      state: { name: statusName },
    },
    updatedFrom: { stateId: "previous" },
  });
}

describe("vercel bridge dispatch-before-ack contract", () => {
  const secret = "test-webhook-secret";
  let handlerPath = "";
  let requireFromDir: NodeRequire;
  let stored: Map<string, { record: Record<string, unknown>; sha: string }>;
  let dispatchCalls: Array<{ requestId: string }>;
  let linearCalls: number;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stored = new Map();
    dispatchCalls = [];
    linearCalls = 0;

    const files = buildVercelBridgeArtifactFiles();
    const js = files.find((file) => file.file.endsWith(".js"));
    const vercelJson = files.find((file) => file.file === "vercel.json");
    expect(js).toBeDefined();
    expect(vercelJson?.data).toContain('"maxDuration": 30');
    expect(js!.data).toContain("ensureOpaqueDispatch");
    expect(js!.data).toContain("resolveLinearIssueIdByIdentifier");
    expect(js!.data).toContain("team: { key: { eq: $teamKey } }");
    expect(js!.data).not.toContain('issue(id: $id)');
    // Handler call order: ensureOpaqueDispatch then attemptAck (definitions may appear earlier).
    const handlerCallSlice = js!.data.slice(js!.data.indexOf("module.exports = async function handler"));
    const dispatchIdx = handlerCallSlice.indexOf("await ensureOpaqueDispatch(envelope)");
    const ackIdx = handlerCallSlice.indexOf("await attemptAck(envelope)");
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(ackIdx).toBeGreaterThan(dispatchIdx);

    const dir = mkdtempSync(path.join(tmpdir(), "bridge-dispatch-"));
    handlerPath = path.join(dir, "linear-webhook.js");
    writeFileSync(handlerPath, js!.data, "utf8");
    requireFromDir = createRequire(path.join(dir, "package.json"));
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ type: "commonjs" }),
      "utf8",
    );

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.github.com") && url.includes("/dispatches")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          client_payload?: { requestId?: string };
        };
        dispatchCalls.push({ requestId: body.client_payload?.requestId ?? "" });
        return new Response(null, { status: 204 });
      }
      if (url.includes("api.github.com") && url.includes("/git/ref/heads/")) {
        return new Response(JSON.stringify({ object: { sha: "abc" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("api.github.com") && url.includes("/contents/")) {
        const pathMatch = url.match(/\.p-dev%2Fjob-requests%2F([^?]+)/) ||
          url.match(/\.p-dev\/job-requests\/([^?]+)/);
        const decoded = pathMatch
          ? decodeURIComponent(pathMatch[1]!).replace(/\.json$/, "")
          : "";
        if ((init?.method || "GET") === "GET") {
          const hit = stored.get(decoded);
          if (!hit) {
            return new Response("{}", { status: 404 });
          }
          return new Response(
            JSON.stringify({
              content: Buffer.from(JSON.stringify(hit.record, null, 2)).toString(
                "base64",
              ),
              sha: hit.sha,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (init?.method === "PUT") {
          const putBody = JSON.parse(String(init.body ?? "{}")) as {
            content: string;
          };
          const record = JSON.parse(
            Buffer.from(putBody.content, "base64").toString("utf8"),
          ) as Record<string, unknown>;
          const requestId = String(record.requestId);
          stored.set(requestId, {
            record,
            sha: `sha-${stored.size + 1}`,
          });
          return new Response(JSON.stringify({ content: { sha: `sha-${stored.size}` } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      if (url.includes("api.linear.app/graphql")) {
        linearCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          query?: string;
        };
        if (body.query?.includes("issues(filter")) {
          return new Response(
            JSON.stringify({
              data: { issues: { nodes: [{ id: "issue-uuid", identifier: "FRE-5" }] } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (body.query?.includes("commentCreate")) {
          return new Response(
            JSON.stringify({ data: { commentCreate: { success: true } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    process.env.LINEAR_WEBHOOK_SECRET = secret;
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.GITHUB_DISPATCH_TOKEN = "gh_dispatch";
    process.env.GITHUB_DISPATCH_REPOSITORY = "weston-uribe/p-dev-harness-runner";
    process.env.P_DEV_JOB_REQUEST_REPOSITORY = "weston-uribe/p-dev-harness-state";
    process.env.P_DEV_STATE_GITHUB_TOKEN = "gh_state";
    process.env.P_DEV_WORKFLOW_STATE_BRANCH = "p-dev-runtime-state";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_API_KEY;
    delete process.env.GITHUB_DISPATCH_TOKEN;
    delete process.env.GITHUB_DISPATCH_REPOSITORY;
    delete process.env.P_DEV_JOB_REQUEST_REPOSITORY;
    delete process.env.P_DEV_STATE_GITHUB_TOKEN;
    delete process.env.P_DEV_WORKFLOW_STATE_BRANCH;
  });

  async function invoke(deliveryId: string, options?: { hangAck?: boolean }) {
    if (options?.hangAck) {
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api.linear.app/graphql")) {
          linearCalls += 1;
          const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
          if (body.query?.includes("commentCreate")) {
            await new Promise(() => {
              /* never resolves — simulates ack timeout after dispatch */
            });
          }
          return new Response(
            JSON.stringify({
              data: { issues: { nodes: [{ id: "issue-uuid", identifier: "FRE-5" }] } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Fall through to default mock for GitHub by re-invoking first impl — simplified:
        if (url.includes("/dispatches")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            client_payload?: { requestId?: string };
          };
          dispatchCalls.push({ requestId: body.client_payload?.requestId ?? "" });
          return new Response(null, { status: 204 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ object: { sha: "abc" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/contents/")) {
          const pathMatch =
            url.match(/\.p-dev%2Fjob-requests%2F([^?]+)/) ||
            url.match(/\.p-dev\/job-requests\/([^?]+)/);
          const decoded = pathMatch
            ? decodeURIComponent(pathMatch[1]!).replace(/\.json$/, "")
            : "";
          if ((init?.method || "GET") === "GET") {
            const hit = stored.get(decoded);
            if (!hit) return new Response("{}", { status: 404 });
            return new Response(
              JSON.stringify({
                content: Buffer.from(JSON.stringify(hit.record, null, 2)).toString(
                  "base64",
                ),
                sha: hit.sha,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (init?.method === "PUT") {
            const putBody = JSON.parse(String(init.body ?? "{}")) as {
              content: string;
            };
            const record = JSON.parse(
              Buffer.from(putBody.content, "base64").toString("utf8"),
            ) as Record<string, unknown>;
            const requestId = String(record.requestId);
            stored.set(requestId, { record, sha: `sha-${stored.size + 1}` });
            return new Response("{}", { status: 200 });
          }
        }
        return new Response("{}", { status: 200 });
      });
    }

    delete requireFromDir.cache[handlerPath];
    const handler = requireFromDir(handlerPath) as (
      req: unknown,
      res: {
        statusCode: number;
        setHeader: (k: string, v: string) => void;
        end: (body: string) => void;
      },
    ) => Promise<void>;

    const rawBody = buildIssuePayload("FRE-5", "Ready to Merge");
    let statusCode = 0;
    let responseBody = "";
    const req = {
      method: "POST",
      headers: {
        "linear-signature": sign(secret, rawBody),
        "linear-timestamp": String(Date.now()),
        "linear-delivery": deliveryId,
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(rawBody);
      },
    };
    const res = {
      statusCode: 0,
      setHeader() {},
      end(body: string) {
        statusCode = this.statusCode;
        responseBody = body;
      },
    };

    const run = handler(req, res);
    if (options?.hangAck) {
      // Ack hangs; wait briefly for dispatch path to finish then abandon.
      await Promise.race([
        run,
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);
      return { statusCode, body: responseBody ? JSON.parse(responseBody) : null };
    }
    await run;
    return { statusCode, body: JSON.parse(responseBody) as Record<string, unknown> };
  }

  it("dispatches once for a delivery and does not re-dispatch on retry", async () => {
    const first = await invoke("delivery-fre5-rtm-1");
    expect(first.statusCode).toBe(200);
    expect(first.body.accepted).toBe(true);
    expect(first.body.dispatched).toBe(true);
    expect(dispatchCalls).toHaveLength(1);
    expect(stored.size).toBe(1);
    const requestId = String(first.body.requestId);
    const record = stored.get(requestId)?.record as {
      dispatch?: { confirmedAt?: string | null };
    };
    expect(record.dispatch?.confirmedAt).toBeTruthy();

    const second = await invoke("delivery-fre5-rtm-1");
    expect(second.statusCode).toBe(200);
    expect(second.body.requestId).toBe(requestId);
    expect(dispatchCalls).toHaveLength(1);
    expect(stored.size).toBe(1);
  });

  it("keeps a single envelope when concurrent creates race", async () => {
    const a = invoke("delivery-race");
    const b = invoke("delivery-race");
    const results = await Promise.all([a, b]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.requestId)).size).toBe(1);
    // Both may observe pending before either confirms; at most one envelope.
    expect(stored.size).toBe(1);
    expect(dispatchCalls.length).toBeGreaterThanOrEqual(1);
    expect(dispatchCalls.length).toBeLessThanOrEqual(2);
  });

  it("establishes durable dispatch even when acknowledgement hangs", async () => {
    const result = await invoke("delivery-ack-hang", { hangAck: true });
    // Handler may still be pending on ack; dispatch side effect must already be done.
    expect(dispatchCalls).toHaveLength(1);
    const requestId = dispatchCalls[0]!.requestId;
    const record = stored.get(requestId)?.record as {
      dispatch?: { confirmedAt?: string | null; attemptedAt?: string | null };
    };
    expect(record?.dispatch?.attemptedAt || record?.dispatch?.confirmedAt).toBeTruthy();
    void result;
  });
});
