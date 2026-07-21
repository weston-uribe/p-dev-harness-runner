import { BRIDGE_HUMAN_OWNED_DISPATCH_STATUSES } from "../webhook/bridge-dispatch-contract.js";

export interface VercelBridgeArtifactFile {
  file: string;
  data: string;
  encoding: "utf-8";
}

/**
 * Self-contained Vercel handler: filter human-owned intake, create private
 * job-request envelope, opaque repository_dispatch first, persist dispatch,
 * then best-effort Linear ack. Embeds the same allowlist as the typed webhook path.
 */
function buildLinearWebhookHandlerSource(): string {
  const statusListLiteral = JSON.stringify([...BRIDGE_HUMAN_OWNED_DISPATCH_STATUSES]);

  return `
const { createHmac, timingSafeEqual, randomUUID, createHash } = require("node:crypto");

const HUMAN_OWNED_DISPATCH_STATUSES = ${statusListLiteral};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()] || req.headers[name];
  return Array.isArray(value) ? value[0] || null : value || null;
}

function computeSignature(secret, rawBody) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function signatureMatches(secret, rawBody, signatureHeader) {
  if (!signatureHeader || !/^[0-9a-f]+$/i.test(signatureHeader)) {
    return false;
  }
  const computed = Buffer.from(computeSignature(secret, rawBody), "hex");
  const provided = Buffer.from(signatureHeader, "hex");
  return computed.length === provided.length && timingSafeEqual(computed, provided);
}

function parseTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timestampOk(payloadTimestamp, headerTimestamp) {
  const toleranceMs = Number(process.env.LINEAR_WEBHOOK_TIMESTAMP_TOLERANCE_MS || 60000);
  const now = Date.now();
  return [payloadTimestamp, headerTimestamp]
    .filter((value) => value !== null)
    .some((value) => Math.abs(now - value) <= toleranceMs);
}

function parseRepoSlug(slug) {
  if (!slug || typeof slug !== "string") return null;
  const parts = slug.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

function jobRequestPath(requestId) {
  const safe = String(requestId).replace(/[^A-Za-z0-9._-]+/g, "_");
  return ".p-dev/job-requests/" + safe + ".json";
}

function dedupeIdentity(issueKey, phase, linearDeliveryId, triggerSource) {
  return createHash("sha256")
    .update(JSON.stringify({
      issueKey: String(issueKey).trim(),
      phase: String(phase).trim(),
      linearDeliveryId: linearDeliveryId ? String(linearDeliveryId).trim() : null,
      triggerSource: String(triggerSource).trim(),
    }))
    .digest("hex");
}

function resolveRequestId(linearDeliveryId) {
  if (linearDeliveryId && String(linearDeliveryId).trim()) {
    const digest = createHash("sha256").update(String(linearDeliveryId).trim(), "utf8").digest("hex");
    return "dlv-" + digest.slice(0, 32);
  }
  return randomUUID();
}

function isHumanOwnedDispatchStatus(statusName) {
  if (!statusName || typeof statusName !== "string") return false;
  const normalized = statusName.trim().toLowerCase();
  return HUMAN_OWNED_DISPATCH_STATUSES.some(
    (status) => status.toLowerCase() === normalized,
  );
}

function isHarnessOwnedComment(body) {
  if (!body || typeof body !== "string" || !body.trim()) return false;
  if (/<!--\\s*p-dev-run-status:/.test(body)) return true;
  if (/harness-orchestrator-v1/i.test(body) && /phase:\\s*\\S+/i.test(body) && /run_id:\\s*\\S+/i.test(body)) {
    return true;
  }
  const lower = body.toLowerCase();
  if (lower.includes("phase: build_complete") || lower.includes("phase: post_build")) {
    return true;
  }
  if (/\\*\\*phase:\\*\\*\\s*pm handoff/i.test(body)) return true;
  if (/\\*\\*phase:\\*\\*\\s*build complete/i.test(body)) return true;
  if (lower.includes("phase: handoff") && /harness-orchestrator-v1/i.test(body)) return true;
  return false;
}

function statusChanged(payload) {
  const data = payload.data || {};
  const updatedFrom = payload.updatedFrom || {};
  if (updatedFrom.stateId !== undefined) return true;
  if (updatedFrom.state !== undefined) return true;
  const prev = data && data.state ? null : null;
  return Boolean(updatedFrom && Object.prototype.hasOwnProperty.call(updatedFrom, "stateId"));
}

async function githubApi(pathname, token, init) {
  const response = await fetch("https://api.github.com" + pathname, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init && init.headers ? init.headers : {}),
    },
  });
  return response;
}

async function ensureStateBranch(owner, repo, branch, token) {
  const refRes = await githubApi(
    "/repos/" + owner + "/" + repo + "/git/ref/heads/" + encodeURIComponent(branch),
    token,
    { method: "GET" },
  );
  if (refRes.ok) return;
  if (refRes.status !== 404) {
    throw new Error("state_branch_lookup_failed");
  }
  const repoRes = await githubApi("/repos/" + owner + "/" + repo, token, { method: "GET" });
  if (!repoRes.ok) throw new Error("state_repo_lookup_failed");
  const repoJson = await repoRes.json();
  const defaultBranch = (repoJson.default_branch || "main").trim();
  const defaultRefRes = await githubApi(
    "/repos/" + owner + "/" + repo + "/git/ref/heads/" + encodeURIComponent(defaultBranch),
    token,
    { method: "GET" },
  );
  if (!defaultRefRes.ok) throw new Error("default_branch_lookup_failed");
  const defaultRef = await defaultRefRes.json();
  const createRes = await githubApi(
    "/repos/" + owner + "/" + repo + "/git/refs",
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: "refs/heads/" + branch,
        sha: defaultRef.object.sha,
      }),
    },
  );
  if (!createRes.ok && createRes.status !== 422) {
    throw new Error("state_branch_create_failed");
  }
}

async function loadJobRequest(owner, repo, branch, token, requestId) {
  const path = jobRequestPath(requestId);
  const res = await githubApi(
    "/repos/" + owner + "/" + repo + "/contents/" + path + "?ref=" + encodeURIComponent(branch),
    token,
    { method: "GET" },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("job_request_load_failed");
  const content = await res.json();
  const raw = Buffer.from(content.content || "", "base64").toString("utf8");
  return { record: JSON.parse(raw), sha: content.sha };
}

async function putJobRequest(owner, repo, branch, token, record, sha) {
  const path = jobRequestPath(record.requestId);
  const body = {
    message: "p-dev: job request " + record.requestId + " r" + record.revision,
    content: Buffer.from(JSON.stringify(record, null, 2), "utf8").toString("base64"),
    branch: branch,
  };
  if (sha) body.sha = sha;
  const putRes = await githubApi(
    "/repos/" + owner + "/" + repo + "/contents/" + path,
    token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!putRes.ok) {
    throw new Error("job_request_write_failed");
  }
}

async function createOrLoadEnvelope(issueKey, phase, triggerSource, linearDeliveryId) {
  const stateSlug =
    process.env.P_DEV_JOB_REQUEST_REPOSITORY ||
    process.env.P_DEV_WORKFLOW_STATE_REPOSITORY;
  const stateToken =
    process.env.P_DEV_STATE_GITHUB_TOKEN || process.env.GITHUB_DISPATCH_TOKEN;
  const branch = process.env.P_DEV_WORKFLOW_STATE_BRANCH || "p-dev-runtime-state";
  const parsed = parseRepoSlug(stateSlug);
  if (!parsed || !stateToken) {
    throw new Error("missing_state_configuration");
  }
  await ensureStateBranch(parsed.owner, parsed.repo, branch, stateToken);
  const requestId = resolveRequestId(linearDeliveryId);
  const existing = await loadJobRequest(
    parsed.owner,
    parsed.repo,
    branch,
    stateToken,
    requestId,
  );
  if (existing) {
    return {
      requestId: existing.record.requestId,
      duplicate: true,
      record: existing.record,
      sha: existing.sha,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: branch,
      token: stateToken,
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const record = {
    kind: "p-dev-job-request-v1",
    schemaVersion: 1,
    requestId: requestId,
    issueKey: issueKey,
    phase: phase,
    triggerSource: triggerSource,
    linearDeliveryId: linearDeliveryId || null,
    force: false,
    createdAt: createdAt,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    state: "pending",
    claimIdentity: null,
    completionState: null,
    dedupeIdentity: dedupeIdentity(issueKey, phase, linearDeliveryId, triggerSource),
    revision: 0,
    ack: {
      // Optional post-dispatch observability; missing LINEAR_API_KEY must not
      // mark a successfully dispatched delivery as failed.
      ackRequired: false,
      acceptedAt: createdAt,
      ackAttemptedAt: null,
      ackConfirmedAt: null,
      ackSource: null,
      ackFailureCategory: null,
    },
    dispatch: {
      attemptedAt: null,
      confirmedAt: null,
      failureCategory: null,
    },
  };
  try {
    await putJobRequest(parsed.owner, parsed.repo, branch, stateToken, record, null);
  } catch {
    const raced = await loadJobRequest(
      parsed.owner,
      parsed.repo,
      branch,
      stateToken,
      requestId,
    );
    if (raced) {
      return {
        requestId: raced.record.requestId,
        duplicate: true,
        record: raced.record,
        sha: raced.sha,
        owner: parsed.owner,
        repo: parsed.repo,
        branch: branch,
        token: stateToken,
      };
    }
    throw new Error("job_request_create_failed");
  }
  const loaded = await loadJobRequest(
    parsed.owner,
    parsed.repo,
    branch,
    stateToken,
    requestId,
  );
  return {
    requestId: requestId,
    duplicate: false,
    record: (loaded && loaded.record) || record,
    sha: loaded && loaded.sha,
    owner: parsed.owner,
    repo: parsed.repo,
    branch: branch,
    token: stateToken,
  };
}

function ensureDispatchLifecycle(record) {
  if (!record.dispatch) {
    record.dispatch = {
      attemptedAt: null,
      confirmedAt: null,
      failureCategory: null,
    };
  }
  return record.dispatch;
}

function isDispatchConfirmed(record) {
  const dispatch = ensureDispatchLifecycle(record);
  return Boolean(dispatch.confirmedAt);
}

async function persistEnvelope(envelope) {
  const latest = await loadJobRequest(
    envelope.owner,
    envelope.repo,
    envelope.branch,
    envelope.token,
    envelope.record.requestId,
  );
  envelope.record.revision = Number((latest && latest.record && latest.record.revision) || envelope.record.revision || 0) + 1;
  await putJobRequest(
    envelope.owner,
    envelope.repo,
    envelope.branch,
    envelope.token,
    envelope.record,
    (latest && latest.sha) || envelope.sha,
  );
  const reloaded = await loadJobRequest(
    envelope.owner,
    envelope.repo,
    envelope.branch,
    envelope.token,
    envelope.record.requestId,
  );
  if (reloaded) {
    envelope.sha = reloaded.sha;
    envelope.record = reloaded.record;
  }
}

async function resolveLinearIssueIdByIdentifier(linearApiKey, issueKey) {
  const match = String(issueKey || "").trim().match(/^([A-Za-z][A-Za-z0-9]*)-(\\d+)$/);
  if (!match) {
    throw new Error("linear_issue_identifier_invalid");
  }
  const teamKey = match[1].toUpperCase();
  const number = Number(match[2]);
  const issueRes = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: linearApiKey,
    },
    body: JSON.stringify({
      query:
        "query($teamKey: String!, $number: Float!) { issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) { nodes { id identifier } } }",
      variables: { teamKey: teamKey, number: number },
    }),
  });
  if (!issueRes.ok) throw new Error("linear_issue_lookup_failed");
  const issueJson = await issueRes.json();
  const nodes =
    issueJson &&
    issueJson.data &&
    issueJson.data.issues &&
    issueJson.data.issues.nodes;
  const issueId = nodes && nodes[0] && nodes[0].id;
  if (!issueId) throw new Error("linear_issue_missing");
  return issueId;
}

async function attemptAck(envelope) {
  const record = envelope.record;
  if (!record.ack || !record.ack.ackRequired || record.ack.ackConfirmedAt) {
    return { confirmed: Boolean(record.ack && record.ack.ackConfirmedAt) };
  }
  const linearApiKey = process.env.LINEAR_API_KEY;
  record.ack.ackAttemptedAt = new Date().toISOString();
  try {
    await persistEnvelope(envelope);
  } catch {
    // best-effort; still attempt Linear ack
  }

  if (!linearApiKey) {
    envelope.record.ack.ackFailureCategory = "missing_linear_api_key";
    try {
      await persistEnvelope(envelope);
    } catch {
      // best-effort
    }
    return { confirmed: false };
  }

  try {
    const issueId = await resolveLinearIssueIdByIdentifier(linearApiKey, record.issueKey);
    const generation = Date.parse(record.createdAt) || Date.now();
    const body = [
      "<!-- p-dev-run-status:" + issueId + " -->",
      "**PDev accepted this issue**",
      "- Phase: \`Preparing the next phase\`",
      "- Last updated: \`" + new Date().toISOString() + "\`",
      "",
      "<!--",
      "generation: " + generation,
      "state_revision: 0",
      "authority_phase: accepted",
      "outcome_class: accepted",
      "owned_active_claim: true",
      "run_id: " + record.requestId,
      record.linearDeliveryId ? "delivery_id: " + record.linearDeliveryId : null,
      "-->",
    ]
      .filter(Boolean)
      .join("\\n");

    const commentRes = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearApiKey,
      },
      body: JSON.stringify({
        query:
          "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
        variables: { issueId: issueId, body: body },
      }),
    });
    if (!commentRes.ok) throw new Error("linear_comment_failed");
    const commentJson = await commentRes.json();
    if (!(commentJson && commentJson.data && commentJson.data.commentCreate && commentJson.data.commentCreate.success)) {
      throw new Error("linear_comment_rejected");
    }

    envelope.record.ack.ackConfirmedAt = new Date().toISOString();
    envelope.record.ack.ackSource = "bridge";
    envelope.record.ack.ackFailureCategory = null;
    try {
      await persistEnvelope(envelope);
    } catch {
      // dispatch already durable; ack persistence is best-effort
    }
    return { confirmed: true };
  } catch {
    envelope.record.ack.ackFailureCategory = "linear_write_failed";
    try {
      await persistEnvelope(envelope);
    } catch {
      // best-effort ack failure persistence
    }
    return { confirmed: false };
  }
}

async function dispatchOpaque(requestId) {
  const repository = process.env.GITHUB_DISPATCH_REPOSITORY;
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!repository || !token) {
    throw new Error("missing_dispatch_configuration");
  }
  const eventType = process.env.GITHUB_DISPATCH_EVENT_TYPE || "linear_issue_status_changed";
  const response = await fetch("https://api.github.com/repos/" + repository + "/dispatches", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: {
        requestId: requestId,
        envelopeSchemaVersion: 1,
        publicEventType: eventType,
      },
    }),
  });
  if (!response.ok) {
    throw new Error("github_dispatch_" + response.status);
  }
  return eventType;
}

async function ensureOpaqueDispatch(envelope) {
  if (isDispatchConfirmed(envelope.record)) {
    return { dispatched: false, alreadyDispatched: true };
  }
  ensureDispatchLifecycle(envelope.record).attemptedAt = new Date().toISOString();
  ensureDispatchLifecycle(envelope.record).failureCategory = null;
  try {
    await persistEnvelope(envelope);
  } catch {
    // continue; GitHub dispatch is the critical side effect
  }
  if (isDispatchConfirmed(envelope.record)) {
    return { dispatched: false, alreadyDispatched: true };
  }
  try {
    await dispatchOpaque(envelope.record.requestId);
    ensureDispatchLifecycle(envelope.record).confirmedAt = new Date().toISOString();
    ensureDispatchLifecycle(envelope.record).failureCategory = null;
    await persistEnvelope(envelope);
    return { dispatched: true, alreadyDispatched: false };
  } catch (error) {
    ensureDispatchLifecycle(envelope.record).failureCategory = "github_dispatch_failed";
    try {
      await persistEnvelope(envelope);
    } catch {
      // best-effort
    }
    throw error;
  }
}

module.exports = async function handler(req, res) {
  if ((req.method || "GET") !== "POST") {
    return json(res, 405, { error: "method_not_allowed" });
  }

  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) {
    return json(res, 500, { error: "dispatch_failed" });
  }

  const rawBody = await readRawBody(req);
  if (!signatureMatches(secret, rawBody, getHeader(req, "linear-signature"))) {
    return json(res, 401, { error: "invalid_signature" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(res, 401, { error: "invalid_signature" });
  }

  if (
    !timestampOk(
      parseTimestampMs(payload && payload.webhookTimestamp),
      parseTimestampMs(getHeader(req, "linear-timestamp")),
    )
  ) {
    return json(res, 401, { error: "timestamp_out_of_tolerance" });
  }

  function issueKeyAllowed(issueKey) {
    const teamKeyRaw = process.env.HARNESS_TEAM_KEY || "";
    const teamKeys = teamKeyRaw
      .split(/[,\\s]+/)
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean);
    if (teamKeys.length === 0) {
      return true;
    }
    const normalizedIssueKey = String(issueKey).toUpperCase();
    return teamKeys.some((key) => normalizedIssueKey.startsWith(key + "-"));
  }

  function issueKeyFromUrl(url) {
    if (!url || typeof url !== "string") {
      return null;
    }
    const match = url.match(new RegExp("/([A-Z]+-" + "\\\\d+" + ")(?:/|$|#)"));
    return match ? match[1] : null;
  }

  let issueKey = null;
  let action = payload.action || "";
  let triggerKind = "issue_status";
  let statusName = null;

  if (payload.type === "Comment") {
    const data = payload.data || {};
    const issue = data.issue || {};
    issueKey = issue.identifier || issueKeyFromUrl(payload.url) || issueKeyFromUrl(issue.url);
    action = payload.action || "";
    triggerKind = "comment_create";
    if (action !== "create" || !issueKey) {
      return json(res, 200, { accepted: false, reason: "ignored_event" });
    }
    if (isHarnessOwnedComment(data.body || "")) {
      return json(res, 200, { accepted: false, reason: "ignored_event" });
    }
  } else if (payload.type === "Issue" && payload.data && payload.data.identifier) {
    issueKey = payload.data.identifier;
    const state = payload.data.state || {};
    statusName = state.name || null;
    if (action === "remove") {
      return json(res, 200, { accepted: false, reason: "ignored_event" });
    }
    if (action === "update" && !statusChanged(payload)) {
      return json(res, 200, { accepted: false, reason: "ignored_event" });
    }
    if (action === "create" || action === "update") {
      if (!isHumanOwnedDispatchStatus(statusName)) {
        return json(res, 200, { accepted: false, reason: "ignored_status" });
      }
    } else {
      return json(res, 200, { accepted: false, reason: "ignored_event" });
    }
  } else {
    return json(res, 200, { accepted: false, reason: "ignored_event" });
  }

  if (!issueKeyAllowed(issueKey)) {
    return json(res, 200, { accepted: false, reason: "team_key_mismatch" });
  }

  try {
    const envelope = await createOrLoadEnvelope(
      issueKey,
      "auto",
      triggerKind === "comment_create" ? "linear_comment" : "linear_issue_status",
      getHeader(req, "linear-delivery"),
    );
    const dispatchResult = await ensureOpaqueDispatch(envelope);
    // Best-effort Linear ack after durable dispatch is established.
    try {
      await attemptAck(envelope);
    } catch {
      // ack must never undo a successful dispatch
    }
    return json(res, 200, {
      accepted: true,
      dispatched: dispatchResult.dispatched || dispatchResult.alreadyDispatched,
      duplicate: Boolean(envelope.duplicate),
      requestId: envelope.requestId,
    });
  } catch {
    return json(res, 500, { error: "dispatch_failed" });
  }
};
`.trimStart();
}

export function buildVercelBridgeArtifactFiles(): VercelBridgeArtifactFile[] {
  return [
    {
      file: "api/linear-webhook.js",
      data: buildLinearWebhookHandlerSource(),
      encoding: "utf-8",
    },
    {
      file: "package.json",
      data: JSON.stringify({ type: "commonjs" }, null, 2),
      encoding: "utf-8",
    },
    {
      file: "vercel.json",
      data: JSON.stringify(
        {
          functions: {
            "api/linear-webhook.js": {
              maxDuration: 30,
            },
          },
        },
        null,
        2,
      ),
      encoding: "utf-8",
    },
  ];
}
