import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { deriveSessionId } from "../src/evaluation/identifiers.js";

const PORT = Number.parseInt(process.env.CURSOR_USAGE_FAKE_LANGFUSE_PORT ?? "18999", 10);
const ISSUE_KEY = "TT-FIXTURE";
const NAMESPACE = "default";
const SESSION_ID = deriveSessionId(NAMESPACE, ISSUE_KEY);

const TRACE_PLANNING = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRACE_PLAN_REVIEW = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT_PLANNING = "bc-agent-planning-001";
const AGENT_PLAN_REVIEW = "bc-agent-planreview-001";

type StoredScore = Record<string, unknown>;

let scores: StoredScore[] = [];
let scoreCreateLog: Array<Record<string, unknown>> = [];
let requestCounters = {
  traceListRequests: 0,
  observationRequests: 0,
  windowObservationRequests: 0,
  perTraceObservationRequests: 0,
  scoreListRequests: 0,
  ingestionRequests: 0,
  activeRequests: 0,
  abortedRequests: 0,
  scoreCreateCount: 0,
  nonLoopbackRequests: 0,
};

/** Scenario overrides for negative browser flows. */
let scenario:
  | "default"
  | "cut_through"
  | "unmatched_extra"
  | "ambiguous"
  | "model_conflict"
  | "variant_conflict"
  | "unknown_pricing"
  | "multi_page" = "default";

const baseTraces = [
  {
    id: TRACE_PLANNING,
    name: "planning",
    sessionId: SESSION_ID,
    timestamp: "2026-07-19T12:00:00.000Z",
    linearIssueKey: ISSUE_KEY,
    phase: "planning",
    phaseExecutionId: "pe-plan",
    harnessRunId: "hr-plan",
    scores: [],
  },
  {
    id: TRACE_PLAN_REVIEW,
    name: "plan_review",
    sessionId: SESSION_ID,
    timestamp: "2026-07-19T12:59:00.000Z",
    linearIssueKey: ISSUE_KEY,
    phase: "plan_review",
    phaseExecutionId: "pe-pr",
    harnessRunId: "hr-pr",
    scores: [],
  },
];

const baseObservations = [
  {
    id: "obs-plan",
    traceId: TRACE_PLANNING,
    name: "planner",
    type: "AGENT",
    startTime: "2026-07-19T12:00:00.000Z",
    endTime: "2026-07-19T12:01:30.000Z",
    model: "composer-2.5",
    providedModelName: "composer-2.5",
    agentId: AGENT_PLANNING,
    phase: "planning",
    phaseExecutionId: "pe-plan",
    harnessRunId: "hr-plan",
    metadata: {
      cursorAgentId: AGENT_PLANNING,
      effectiveVariant: "standard",
      fast: false,
      linearIssueKey: ISSUE_KEY,
      issueKey: ISSUE_KEY,
    },
  },
  {
    id: "obs-pr",
    traceId: TRACE_PLAN_REVIEW,
    name: "plan_reviewer",
    type: "AGENT",
    startTime: "2026-07-19T12:59:00.000Z",
    endTime: "2026-07-19T13:00:00.000Z",
    model: "composer-2.5",
    providedModelName: "composer-2.5",
    agentId: AGENT_PLAN_REVIEW,
    phase: "plan_review",
    phaseExecutionId: "pe-pr",
    harnessRunId: "hr-pr",
    metadata: {
      cursorAgentId: AGENT_PLAN_REVIEW,
      effectiveVariant: "standard",
      fast: false,
      linearIssueKey: ISSUE_KEY,
      issueKey: ISSUE_KEY,
    },
  },
];

function currentObservations() {
  if (scenario === "cut_through") {
    // Execution starts before a typical narrow export window used in tests.
    return baseObservations.map((obs) =>
      obs.traceId === TRACE_PLANNING
        ? {
            ...obs,
            startTime: "2026-07-19T03:00:00.000Z",
            endTime: "2026-07-19T12:05:00.000Z",
          }
        : obs,
    );
  }
  if (scenario === "ambiguous") {
    return [
      ...baseObservations,
      {
        ...baseObservations[0]!,
        id: "obs-plan-alt",
        traceId: "cccccccccccccccccccccccccccccccc",
        agentId: AGENT_PLANNING,
        metadata: {
          ...baseObservations[0]!.metadata,
          cursorAgentId: AGENT_PLANNING,
        },
      },
    ];
  }
  if (scenario === "model_conflict") {
    return baseObservations.map((obs) =>
      obs.traceId === TRACE_PLANNING
        ? {
            ...obs,
            model: "totally-different-model",
            providedModelName: "totally-different-model",
          }
        : obs,
    );
  }
  if (scenario === "variant_conflict") {
    // Candidate effectiveVariant=standard from a model-less obs (must sort first by id);
    // observed model evidence carries fast — reconciliation yields variant_identity_conflict.
    return baseObservations.flatMap((obs) => [
      {
        ...obs,
        id: `${obs.id}-aaa-variant-authority`,
        model: undefined,
        providedModelName: undefined,
        metadata: {
          ...obs.metadata,
          effectiveVariant: "standard",
          fast: false,
        },
      },
      {
        ...obs,
        id: `${obs.id}-zzz-fast-evidence`,
        metadata: {
          ...obs.metadata,
          effectiveVariant: "fast",
          fast: true,
        },
      },
    ]);
  }
  if (scenario === "unknown_pricing") {
    // Candidate has authoritative standard; observed model evidence has unknown variant.
    return baseObservations.flatMap((obs) => [
      {
        ...obs,
        id: `${obs.id}-variant-authority`,
        model: undefined,
        metadata: {
          ...obs.metadata,
          effectiveVariant: "standard",
          fast: false,
        },
      },
      {
        ...obs,
        id: `${obs.id}-unknown-variant`,
        metadata: {
          cursorAgentId: obs.metadata.cursorAgentId,
          linearIssueKey: ISSUE_KEY,
          issueKey: ISSUE_KEY,
          // omit effectiveVariant / fast → observed variant unknown
        },
      },
    ]);
  }
  return baseObservations;
}

function currentTraces() {
  if (scenario === "ambiguous") {
    return [
      ...baseTraces,
      {
        id: "cccccccccccccccccccccccccccccccc",
        name: "planning-alt",
        sessionId: SESSION_ID,
        timestamp: "2026-07-19T12:00:00.000Z",
        linearIssueKey: ISSUE_KEY,
        phase: "planning",
        phaseExecutionId: "pe-plan-alt",
        harnessRunId: "hr-plan-alt",
        scores: [],
      },
    ];
  }
  if (scenario === "unmatched_extra") {
    // No change to traces — unmatched comes from CSV side.
    return baseTraces;
  }
  return baseTraces;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function filterTraces(url: URL): typeof baseTraces {
  const from = parseTimestamp(url.searchParams.get("fromTimestamp"));
  const to = parseTimestamp(url.searchParams.get("toTimestamp"));
  return currentTraces().filter((trace) => {
    const ts = parseTimestamp(trace.timestamp);
    if (ts == null) return true;
    if (from != null && ts < from) return false;
    if (to != null && ts > to) return false;
    return true;
  });
}

function handleTraces(url: URL, res: ServerResponse): void {
  requestCounters.traceListRequests += 1;
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const all = filterTraces(url);
  if (scenario === "multi_page") {
    // Force two pages with page size 1 so discovery must paginate.
    const totalPages = Math.max(1, all.length);
    const slice = all.slice((page - 1) * 1, page * 1);
    sendJson(res, 200, {
      data: slice,
      meta: { page, limit: 1, totalPages, totalItems: all.length },
    });
    return;
  }
  sendJson(res, 200, {
    data: all,
    meta: { page, limit, totalPages: 1, totalItems: all.length },
  });
}

function handleObservations(url: URL, res: ServerResponse): void {
  requestCounters.observationRequests += 1;
  const traceId = url.searchParams.get("traceId");
  if (traceId) {
    requestCounters.perTraceObservationRequests += 1;
  } else {
    requestCounters.windowObservationRequests += 1;
  }
  const fromStart = url.searchParams.get("fromStartTime");
  const toStart = url.searchParams.get("toStartTime");
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const cursorRaw = url.searchParams.get("cursor");
  let offset = 0;
  if (cursorRaw) {
    try {
      const decoded = Buffer.from(cursorRaw, "base64url").toString("utf8");
      offset = Number.parseInt(decoded, 10) || 0;
    } catch {
      offset = 0;
    }
  }

  let data = currentObservations().filter((obs) => {
    if (traceId && obs.traceId !== traceId) return false;
    const start = typeof obs.startTime === "string" ? obs.startTime : null;
    if (fromStart && start && start < fromStart) return false;
    if (toStart && start && start >= toStart) return false;
    return true;
  });
  // Sort by startTime then id (v2 contract)
  data = [...data].sort((a, b) => {
    const sa = String(a.startTime ?? "");
    const sb = String(b.startTime ?? "");
    if (sa !== sb) return sa.localeCompare(sb);
    return String(a.id).localeCompare(String(b.id));
  });

  const pageSize = Math.min(Math.max(1, limit), 1000);
  const slice = data.slice(offset, offset + pageSize);
  const nextOffset = offset + slice.length;
  const meta: Record<string, unknown> = {};
  if (nextOffset < data.length) {
    meta.cursor = Buffer.from(String(nextOffset), "utf8").toString("base64url");
  }
  // Map model → providedModelName for v2 shape when missing
  const mapped = slice.map((obs) => ({
    ...obs,
    providedModelName:
      (obs as { providedModelName?: string }).providedModelName ??
      (obs as { model?: string }).model ??
      null,
  }));
  sendJson(res, 200, { data: mapped, meta });
}

function handleScores(url: URL, res: ServerResponse): void {
  requestCounters.scoreListRequests += 1;
  const traceId = url.searchParams.get("traceId");
  const data = traceId
    ? scores.filter((score) => score.traceId === traceId)
    : scores;
  sendJson(res, 200, {
    data,
    meta: { page: 1, limit: data.length, totalPages: 1 },
  });
}

async function handleIngestion(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requestCounters.ingestionRequests += 1;
  const raw = await readBody(req);
  let payload: { batch?: Array<Record<string, unknown>> } = {};
  try {
    payload = JSON.parse(raw) as { batch?: Array<Record<string, unknown>> };
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  for (const event of payload.batch ?? []) {
    if (event.type !== "score-create") continue;
    const body = (event.body ?? {}) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : crypto.randomUUID();
    const record = {
      id,
      name: body.name,
      traceId: body.traceId,
      value: body.value,
      dataType: body.dataType,
      timestamp: event.timestamp ?? body.timestamp,
      comment: body.comment,
      metadata: body.metadata,
    };
    scores.push(record);
    scoreCreateLog.push({ type: "score-create", ...record });
    requestCounters.scoreCreateCount += 1;
  }

  sendJson(res, 200, { successes: (payload.batch ?? []).map((event) => event.id) });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/__test__/score-creates") {
    sendJson(res, 200, { count: scoreCreateLog.length, events: scoreCreateLog });
    return;
  }
  if (req.method === "GET" && url.pathname === "/__test__/request-counts") {
    sendJson(res, 200, { ...requestCounters });
    return;
  }
  if (req.method === "POST" && url.pathname === "/__test__/reset") {
    scores = [];
    scoreCreateLog = [];
    requestCounters = {
      traceListRequests: 0,
      observationRequests: 0,
      windowObservationRequests: 0,
      perTraceObservationRequests: 0,
      scoreListRequests: 0,
      ingestionRequests: 0,
      activeRequests: 0,
      abortedRequests: 0,
      scoreCreateCount: 0,
      nonLoopbackRequests: 0,
    };
    scenario = "default";
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/__test__/scenario") {
    const raw = await readBody(req);
    try {
      const body = JSON.parse(raw) as { scenario?: string };
      if (
        body.scenario === "default" ||
        body.scenario === "cut_through" ||
        body.scenario === "unmatched_extra" ||
        body.scenario === "ambiguous" ||
        body.scenario === "model_conflict" ||
        body.scenario === "variant_conflict" ||
        body.scenario === "unknown_pricing" ||
        body.scenario === "multi_page"
      ) {
        scenario = body.scenario;
        scores = [];
        scoreCreateLog = [];
        requestCounters = {
          traceListRequests: 0,
          observationRequests: 0,
          windowObservationRequests: 0,
          perTraceObservationRequests: 0,
          scoreListRequests: 0,
          ingestionRequests: 0,
          activeRequests: 0,
          abortedRequests: 0,
          scoreCreateCount: 0,
          nonLoopbackRequests: 0,
        };
        sendJson(res, 200, { ok: true, scenario });
        return;
      }
    } catch {
      // fall through
    }
    sendJson(res, 400, { error: "invalid_scenario" });
    return;
  }
  if (url.pathname === "/api/public/traces") {
    handleTraces(url, res);
    return;
  }
  if (url.pathname === "/api/public/v2/observations") {
    handleObservations(url, res);
    return;
  }
  if (url.pathname === "/api/public/v3/scores") {
    handleScores(url, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/public/ingestion") {
    await handleIngestion(req, res);
    return;
  }
  sendJson(res, 404, { error: "not_found", path: url.pathname });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`cursor-usage fake langfuse listening on ${PORT}\n`);
});
