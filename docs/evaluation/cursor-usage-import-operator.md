# Cursor usage import (operator guide)

Bulk import of Cursor usage CSV into Langfuse as **score-only** enrichment on existing harness phase traces.

## What this does / does not do

| Does | Does not |
|------|----------|
| Attach deterministic token/cost proxy scores to agent-invoking phase traces | Mutate historical Langfuse observations or recreate traces |
| Use Cloud Agent ID → Cursor Agent ID join | Treat Admin API events as issue/phase attribution (aggregate-only under current docs) |
| Require an explicit Cursor export window for source-scope completeness | Invent export bounds from the first/last CSV row |
| Keep private Cloud Agent IDs in server-side staged artifacts only | Fix the native Langfuse generation cost dashboard |
| Revalidate the approved score plan (manifest digests) on Apply | Silently apply when discovery targets or pricing inputs changed |

Native `generationCostComplete` / `cursor_exact_cost_complete` remain false until Cursor reports truthful generation usage.

## Source scope (locked)

- Export window must **contain** the agent execution window (default safety margin `0` ms).
- Attribution may use a separate ingestion slack for candidate matching; that slack does **not** expand the export window.
- Every CSV row is in scope. There are no operator issue/phase exclusion filters in this checkpoint.
- Parser rejections without recoverable Cloud Agent identity are **upload-scoped** and block the entire upload.
- Model/variant conflicts make source scope incomplete and disable Apply.

## Discovery configuration (required)

Cursor usage discovery uses a dedicated configuration contract (not broader evaluation runtime defaults).

| Variable | Required | Meaning |
|----------|----------|---------|
| `P_DEV_EVALUATION_PROVIDER` | yes | Must be `langfuse` |
| `P_DEV_EVALUATION_NAMESPACE` | yes | Explicit nonempty namespace (no `"default"` fallback) |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | yes | API credentials (never shown in the GUI) |
| `LANGFUSE_BASE_URL` | recommended | Canonical endpoint; production requires HTTPS |
| `LANGFUSE_TRACING_ENVIRONMENT` | optional | Explicit environment filter; **unset means all environments**, not `"default"` |

Weston dogfood intended values:

- provider: `langfuse`
- namespace: `weston-dogfood`
- environment: `dogfood`

Configuration, authentication, timeout, and retrieval failures **do not create preflights**. Successful complete retrieval with zero traces, zero viable candidates, or zero agent-hash overlap may stage as incomplete diagnostic preflights with distinct source-scope reasons. A successful preflight is **not** Apply authorization.

Approval is bound to provider, namespace, nullable environment filter, full canonical endpoint identity, a private Langfuse project-scope digest (never exposed in the GUI), discovery algorithm / observation eligibility contracts, and the deterministic discovery evidence digest.

## Langfuse discovery (importer v13+)

Production discovery uses **public Langfuse Observations API v2** with **sequential cursor pagination** over the export window (expanded only by the approved source-coverage safety margin; default `0` ms). It does **not** use per-trace observation N+1 calls, page-number / `totalPages` observation pagination, or private dashboard endpoints.

Trace.list requests use field group **`core,scores` only** (no `io`). Candidate construction needs core identity fields, metadata, and shallow score-name diagnostics; prompt/output bodies are never fetched.

### Observation eligibility (`cursor_usage_observation_eligibility_v1`)

- Query interval is half-open **`[fromStartTime, toStartTime)`** in canonical UTC.
- Only observations whose `startTime` lies in that interval participate in candidate construction.
- A complete window query proves coverage of that interval; it does **not** prove that every observation belonging to each selected trace was retrieved (eligibility is not all-observations-per-trace).

### Completeness, timeout, cancel

- Shared discovery ceiling: **180s** (`CURSOR_USAGE_DISCOVERY_TIMEOUT_MS`). Timeout / cancel aborts in-flight requests, waits for settlement, and creates **no** staging, ledger, analytics entry, or score client.
- Explicit cancel (`DELETE`) acknowledges with `cancelRequested=true` while discovery remains **nonterminal**. Terminal state becomes **`cancelled`** with code `langfuse_discovery_cancelled` only after the discovery promise settles. The GUI keeps polling and may show “Cancelling…” until then. Timeout finishes as **`failed`** with `langfuse_discovery_timeout`, never as cancelled.
- Trace-list embedded scores are **non-authoritative diagnostics only**. Apply still performs complete score-fetch + manifest validation before any write.

### Single-flight (`process_local_single_flight`)

- One discovery at a time per operator workspace + Langfuse project-scope + endpoint + namespace + environment filter (window **excluded** from the lock key).
- A second preflight/Apply against the same target returns `cursor_usage_discovery_already_running` (409), even for a different CSV window.
- Enforcement scope: **`same_host_shared_workspace`** — process-local map plus a workspace-scoped advisory filesystem lease (`wx` + PID liveness). This is **not** distributed locking across separate hosts or serverless/multi-instance deployments.
- Process-local operation resume after refresh is supported only on the **persistent PDev GUI** topology (`npm start` / `p-dev`). Do not claim refresh-safe recovery on serverless/multi-instance hosts.

### Async preflight lifecycle

1. `POST /api/settings/cursor-usage/preflight` returns **202** with `operationId` only after auth, upload validation, source inspection, config validation, digest/token binding, and single-flight acquisition.
2. GUI polls `GET` status (operator auth + workspace binding; operationId alone is not authorization) and may `DELETE` to cancel **before** atomic staging commit begins. DELETE is an acknowledgement only; continue polling until terminal `cancelled`.
3. Staging writes to an operation-owned temp directory, then **atomically renames** into the final import id. Cancel during `committing` returns `cursor_usage_preflight_cancel_too_late` (409).
4. Retained CSV bytes are released on cancel acknowledgement, any terminal state, or when successful atomic commit begins. Status TTL retains only public-safe terminal results (~15 min), not CSV bytes.
5. Browser fetch abort ≠ server cancel — use **Cancel** to abort server discovery.

### Apply parity

Apply re-runs the **same** window-scoped v2 discovery + eligibility contract under the same single-flight lock, then compares deterministic evidence / approval fingerprints. Score client creation happens only after those comparisons pass. Timeout, incomplete retrieval, integrity failure, or API failure → zero scores, no score client, approved staging left intact. Successful preflight is **not** Apply authorization.

Legacy staged imports from importer ≤12 require a new preflight (`staged_import_version_mismatch_requires_new_preflight`).

Importer **13.0.0** staged (nonverified) preflights remain readable, but Apply under **13.0.1+** rediscovers and compares deterministic discovery evidence. Because trace list fields no longer include `io`, unused IO-derived metadata (`resourceAttributes` / `scope`) is absent and `tracesDigest` may change — a mismatch fails Apply before score-client creation (`preflight_plan_changed:discovery_evidence`) and requires a **new preflight**. Old verified ledgers are never rewritten.

## Primary workflow (GUI)

1. Start the operator GUI (`npm start` / `p-dev`) from a workspace with the discovery variables above.
2. Open **Settings → Cursor usage**. Confirm Langfuse configured, namespace, environment filter (or All environments), and host.
3. Drag-and-drop an official Cursor usage CSV (≤ 25 MiB). Source inspection runs automatically and can populate the observed export window.
4. Optionally enable advanced override for a manual export window; otherwise use the inspected CSV row extrema.
5. Run **Preflight** (disabled while another discovery is active or until configuration/inspection is ready). Watch phase/progress; use **Cancel** before staging commit if needed. Review diagnostics, matched / conflict / unresolved rows, and rejection reason codes (never raw rejected cells or full agent/session IDs).
6. Apply is disabled when source scope is incomplete, upload-scoped rejections exist, or conflicts exist.
7. Confirm and **Apply**. The GUI sends the preflight approval fingerprint; Apply revalidates discovery configuration and rebuilds discovery, pricing, and the expected-score manifest and fails closed if they differ.
8. Refresh-safe: durable staging/ledger recover import state; in-flight async preflight operation IDs may resume from `sessionStorage` only while the same persistent GUI process still holds the operation registry.
9. Use **Analytics** for local ledger evidence completeness and Langfuse reconciliation status (credentials alone never mark reconciliation complete). Totals cover **only ledgers in the current operator workspace**.

## CLI recovery

```bash
npm run evaluation:import-cursor-usage -- \
  --csv ./usage.csv \
  --inspect-report ./inspect.json \
  --issue FRE-6 \
  --export-start 2026-07-19T00:00:00.000Z \
  --export-end 2026-07-20T00:00:00.000Z \
  --dry-run
```

Omit `--dry-run` only after preflight review. Prefer the GUI bulk path for multi-issue imports.

## Admin API

Optional aggregate view via `CURSOR_ADMIN_API_KEY` (server-only). Documented fields only; **no** issue/phase score writes. `cursor_admin_api_deterministic_attribution_proven` remains false.

## Forbidden

Do not use `cursor.com/api/dashboard/export-usage-events-csv` or browser cookie auth.

## Canary

```bash
# Offline / staged validation only (no Langfuse writes)
npm run evaluation:canary-cursor-usage-import

# Live apply: requires Langfuse credentials. Creates disposable deterministic
# traces before import — no operator-created traces required.
npm run evaluation:canary-cursor-usage-import -- --apply
```

Dry mode = staged validation. `--apply` self-seeds planning + plan_review traces, then imports and verifies scores.

## Browser E2E

```bash
npm run test:cursor-usage:browser
```

This is separate from `npm test` and `test:operator:browser`.
