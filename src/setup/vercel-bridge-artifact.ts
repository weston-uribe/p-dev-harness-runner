export interface VercelBridgeArtifactFile {
  file: string;
  data: string;
  encoding: "utf-8";
}

/**
 * Self-contained Vercel handler: create private job-request envelope, then
 * repository_dispatch with opaque requestId only.
 */
const linearWebhookHandler = String.raw`
const { createHmac, timingSafeEqual, randomUUID, createHash } = require("node:crypto");

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

async function createJobRequestEnvelope(issueKey, phase, triggerSource, linearDeliveryId) {
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
  const requestId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const record = {
    kind: "p-dev-job-request-v1",
    schemaVersion: 1,
    requestId: requestId,
    issueKey: issueKey,
    phase: phase,
    triggerSource: triggerSource,
    linearDeliveryId: linearDeliveryId || null,
    force: false,
    createdAt: now.toISOString(),
    expiresAt: expiresAt,
    state: "pending",
    claimIdentity: null,
    completionState: null,
    dedupeIdentity: dedupeIdentity(issueKey, phase, linearDeliveryId, triggerSource),
    revision: 0,
  };
  const path = jobRequestPath(requestId);
  const putRes = await githubApi(
    "/repos/" + parsed.owner + "/" + parsed.repo + "/contents/" + path,
    stateToken,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "p-dev: create job request " + requestId,
        content: Buffer.from(JSON.stringify(record, null, 2), "utf8").toString("base64"),
        branch: branch,
      }),
    },
  );
  if (!putRes.ok) {
    throw new Error("job_request_create_failed");
  }
  return requestId;
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
      .split(/[,\s]+/)
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
    const match = url.match(new RegExp("/([A-Z]+-" + "\\d+" + ")(?:/|$|#)"));
    return match ? match[1] : null;
  }

  let issueKey = null;
  let action = payload.action || "";
  let triggerKind = "issue_status";
  let commentId = null;

  if (payload.type === "Comment") {
    const data = payload.data || {};
    const issue = data.issue || {};
    issueKey = issue.identifier || issueKeyFromUrl(payload.url) || issueKeyFromUrl(issue.url);
    action = payload.action || "";
    triggerKind = "comment_create";
    commentId = data.id || null;
    if (action !== "create" || !issueKey) {
      return json(res, 200, { accepted: false, reason: "ignored_event" });
    }
  } else if (payload.type === "Issue" && payload.data && payload.data.identifier) {
    issueKey = payload.data.identifier;
  } else {
    return json(res, 200, { accepted: false, reason: "ignored_event" });
  }

  if (!issueKeyAllowed(issueKey)) {
    return json(res, 200, { accepted: false, reason: "team_key_mismatch" });
  }

  try {
    const requestId = await createJobRequestEnvelope(
      issueKey,
      "auto",
      triggerKind === "comment_create" ? "linear_comment" : "linear_issue_status",
      getHeader(req, "linear-delivery"),
    );
    await dispatchOpaque(requestId);
    return json(res, 200, {
      accepted: true,
      dispatched: true,
      requestId: requestId,
    });
  } catch {
    return json(res, 500, { error: "dispatch_failed" });
  }
};
`.trimStart();

export function buildVercelBridgeArtifactFiles(): VercelBridgeArtifactFile[] {
  return [
    {
      file: "api/linear-webhook.js",
      data: linearWebhookHandler,
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
              maxDuration: 10,
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
