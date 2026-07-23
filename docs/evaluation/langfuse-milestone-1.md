# Langfuse Milestone 1 — Online Trace Foundation

Maintainer-only evaluation tracing for PDev. This is **trace infrastructure**, not automated quality evaluation.

Validation mode for the initial delivery: see [`docs/validation-levels.md`](../validation-levels.md) (Rapid Development).

## Purpose and scope

Emit privacy-safe Langfuse traces for:

- `p-dev.implementation`
- `p-dev.handoff`

grouped under one deterministic issue session. Existing manifests and run artifacts remain authoritative.

## Maintainer-only status

Enabled only via environment variables in the maintainer’s managed private harness repository.

Do **not** expect:

- Configure / Settings UI
- `HarnessConfig` / `.harness/config.local.json` fields
- Public-user consent or onboarding
- Langfuse MCP/CLI calls during harness execution

Runtime traces are emitted by PDev code only.

## Environment variables

| Variable | Placement | Notes |
|---|---|---|
| `P_DEV_EVALUATION_PROVIDER` | GitHub Actions variable | Set to `langfuse` to enable |
| `P_DEV_EVALUATION_CAPTURE_PROFILE` | Variable | `metadata-v1` |
| `P_DEV_EVALUATION_NAMESPACE` | Variable | e.g. `weston-dogfood` |
| `LANGFUSE_PUBLIC_KEY` | Secret | Project public key |
| `LANGFUSE_SECRET_KEY` | Secret | Project secret key |
| `LANGFUSE_BASE_URL` | Variable | e.g. `https://us.cloud.langfuse.com` |
| `LANGFUSE_TRACING_ENVIRONMENT` | Variable | e.g. `dogfood` |
| `LANGFUSE_RELEASE` | Set in workflow to `${{ github.sha }}` | Release/commit correlation |

Wired into the `run-harness` job only (not gate, merge, or production-sync).

Absent provider → silent no-op. Unknown provider/profile or missing keys → one concise warning + no-op. Misconfiguration does not fail `doctor` or block phases.

**Cursor usage discovery** (Settings → Cursor usage) uses a stricter dedicated contract: `P_DEV_EVALUATION_PROVIDER` and `P_DEV_EVALUATION_NAMESPACE` are required with no `"default"` namespace fallback; `LANGFUSE_TRACING_ENVIRONMENT` is an optional explicit filter (unset means all environments, not `"default"`). See [`cursor-usage-import-operator.md`](./cursor-usage-import-operator.md).

## Data allowlist (`metadata-v1`)

Bounded structured fields only (IDs, roles, booleans, counts, categories, allowlisted numeric usage). See `src/evaluation/capture-policy.ts`.

## Forbidden content

Must not transmit issue title/description/criteria, prompts, Cursor responses, tool payloads, source/diffs/paths, repository/PR/preview URLs, Linear comment bodies, raw check text, error messages/stacks, hostnames, or credentials.

## Failure behavior

Evaluation is non-authoritative. Init/export/flush failures never change exit codes, Linear status, Cursor execution, or manifest outcomes (beyond optional `evaluation` correlation). Flush is bounded.

## Trace / session model

- **Session seed:** `p-dev:issue-session:v1:<namespace>:<issueKey>` → SHA-256 hex session ID
- **Trace seed:** `p-dev:phase-trace:v1:<namespace>:<runId>` → Langfuse `createTraceId`
- Manifest `evaluation` block carries `sessionId` + `traceId` when enabled

### Implementation children

`p-dev.preflight`, `p-dev.cursor.builder` (agent), `p-dev.github.pr-validation`, `p-dev.preview` (only if configured), `p-dev.linear.status-transition`

### Handoff children

`p-dev.preflight`, `p-dev.github.pr-inspection`, `p-dev.preview` (only if configured), `p-dev.handoff.publish`, `p-dev.linear.status-transition`

## Local mocked validation

```bash
npm run build
npx vitest run tests/evaluation
```

## Live dogfood validation (Rapid)

1. Create Langfuse US project `p-dev-maintainer-evals` and API keys.
2. Set secrets/vars on the private harness repo.
3. Run one small non-sensitive issue Ready for Build → PM Review.
4. Confirm one session with implementation + handoff traces, expected children, correlation IDs matching run artifacts, and no forbidden content.
5. Duplicate handoff attempts (webhook races) may appear labeled `duplicate`.

Checkpoint-deferred:

- Invalid key/endpoint live runs; provider-disabled confirmation.
- Investigate and remove `legacy-peer-deps` by resolving Langfuse / OpenTelemetry / Sentry peer dependency compatibility so managed installs no longer require that npm setting.

## How to disable

Unset `P_DEV_EVALUATION_PROVIDER` (or leave it unset). Next runs export no Langfuse traces.

## Deferred milestones

Scores, datasets, judges, experiments, planning/revision/merge/repair tracing, full prompt/response capture, Configure UI, user-owned Langfuse accounts.
