# ADR 0008: Cursor Cloud Agent provenance registry (Linear-harness capture)

**Status:** Accepted (capture + importer registry consumption)  
**Date:** 2026-07-22  
**Updated:** 2026-07-23

## Context

Cursor Cloud Agent usage can be created by many surfaces: production Linear-harness phases, evaluation canaries, SDK probes, native Cursor integrations, and manual desktop agents. A future CSV usage importer cannot treat “API-created Cloud Agent” or repository equality as proof of production Linear-harness scope.

Historical inventory showed large scope-ambiguous token mass. The current real CSV import remains permanently preflight-only unless new authoritative historical evidence appears. This ADR defines **capture-only** production provenance so future closed coverage intervals can exist — without activating importer consumption, Apply, or a live complete epoch in this change.

## Decision

### Scope

Only `production_linear_issue_harness` launches are in scope. Inclusion requires a durable binding between the Cursor agent/run and:

- Linear issue identity
- phase
- harness run / phase execution identity
- production orchestrator provenance

Generic `Agent.create` / API-created status / repo / branch / account / model / Cloud Agent ID / Langfuse environment alone are **insufficient**.

### Architecture boundary

- Keep [`src/cursor/agent-factory.ts`](../../src/cursor/agent-factory.ts) and [`src/agents/cursor-provider.ts`](../../src/agents/cursor-provider.ts) **provenance-free** for tests, canaries, and probes.
- Production phases call [`src/agents/production.ts`](../../src/agents/production.ts) → `LinearHarnessAgentProvider`, which requires branded `LinearHarnessLaunchContext` in **all** modes.
- Only mode `required` makes runtime registry availability a provider-mutation / phase-progression gate.

### Modes

| Mode | Writes | Blocks Cursor/phase on provenance failure | Coverage-epoch eligible |
|------|--------|-------------------------------------------|-------------------------|
| `disabled` (default) | No | No | Never |
| `shadow` | Attempts full sequence; gap diagnostics on failure | **No** | Never |
| `required` | Full sequence | **Yes** | Only eligible mode |

`shadow` must never silently behave as `required`. Live rollout of `shadow`/`required` requires a separate operator-authorized deployment; this implementation ships code and config support with default `disabled` only.

### Durable execution identity

`providerOperationId` is allocated deterministically and must be preserved across process retries before `launch_intent`. It participates in `launchAttemptId`. Wall-clock time must not substitute for a missing operation ID. Concurrent divergent contexts sharing one operation ID fail closed.

### Immutable events

Schema: `p-dev.cursor-cloud-agent-provenance.v1`

Event types: `launch_intent`, `provider_call_started`, `provider_agent_acknowledged`, `provider_run_bound`, `execution_completed`, `launch_failed`, `reconciliation_resolution`.

Paths under `.p-dev/cursor-cloud-agent-provenance/events/...` on private state branch `p-dev-runtime-state` (create-only Contents CAS). Singleton per-attempt events; run-specific events keyed by run hash; failure/reconciliation keyed by deterministic stage identity.

Canonical semantic digest excludes retry `recordedAt`, encryption nonce/ciphertext, commit SHA, retry count, and elapsed time. Identical digest → idempotent success; divergent → `cursor_provenance_event_divergence`.

### Mutation order

**Launch (create/resume/replacement):**

1. Await production bootstrap gate (shadow/required)  
2. Persist `launch_intent`  
3. Persist `provider_call_started`  
4. Call Cursor create/resume  
5. Persist `provider_agent_acknowledged`  

**Send (every intentional `agent.send`):**

1. Await the same bootstrap gate  
2. Resolve durable `providerRunOperationId` (not wall-clock; restart-stable)  
3. Persist `provider_run_intent`  
4. Persist `provider_run_call_started`  
5. Only then call `agent.send`  
6. Persist `provider_run_bound` before `cursor_agent_created` / telemetry / later callbacks  
7. Persist `execution_completed` after authoritative terminal wait/poll  

Cancel/timeout without authoritative terminal result must **not** synthesize completion; overlapping coverage remains incomplete. A completed earlier run must not hide an unresolved later run operation.

### Encryption and privacy boundary

AES-256-GCM envelopes for full agent/run IDs (`P_DEV_PROVENANCE_KEY_V1`). Joins use `agentHash` / `runHash` + execution window — importer/GUI must not require decryption. Restricted recovery tooling may decrypt.

**Provenance event store and public-safe provenance diagnostics** must not persist or emit plaintext Cursor agent/run IDs in paths, commit messages, or gap logs.

**Public Linear identity contract (canary-readiness repair):** new harness comments must write only canonical SHA-256 public hashes (`cursor_agent_id_hash`, `cursor_run_id_hash`, `builder_agent_id_hash`, `previous_builder_agent_id_hash`) matching `hashProviderIdentity` (`^[0-9a-f]{64}$`). Legacy raw marker fields remain readable for historical issues; new comments must never write them. Cursor Cloud URLs embedding complete provider IDs are not emitted on new comments.

**Approved private plaintext identity boundaries** (not public/Linear):

- Transient in-memory provider calls and responses
- Encrypted provenance envelopes
- Private workflow-state Builder resume fields
- Existing private Langfuse telemetry
- Ephemeral local `runs/` artifacts that are not uploaded or publicly projected

Privacy verdicts for the provenance event store remain scoped to that store and public-safe provenance diagnostics.

### Closed coverage epochs

Schema: `p-dev.cursor-cloud-agent-registry-coverage.v1`

Coverage uses closed intervals `[coverageStart, coverageEnd)` by **execution overlap**, not event-timestamp-only membership. Open-ended “complete from now” is unsupported. A later clean epoch must not rewrite an earlier incomplete interval. Current branch tip alone is not an Apply contract.

Complete coverage requires (test-only until an operator-activated epoch exists):

- a **persisted activation record** (canonical payload + payload digest; no self-referential commit SHA);
- a **retrieved activation source** (repo/branch/path/immutable commit of the fetched bytes);
- a **verified activation-history proof** (`p-dev.cursor-cloud-agent-activation-history-proof.v1`) produced by a commit-graph verifier — caller-declared `descendant` alone is insufficient;
- typed activation lifecycle records valid for the full interval;
- topology-derived workflow install + durable runner deployment-slot manifests with full-interval evidence;
- independently derived transition IDs for every event variant;
- exact reconciliation variant payloads (`provider_agent_ack_recovered` never closes activity).

No complete coverage interval is activated by this change.

### Importer registry consumption (implemented)

Cursor usage importer **14.0.0+** consumes the private provenance registry under `src/evaluation/cursor-usage-import/provenance-scope/`.

Join contract (run-operation level, not agent-hash alone):

- Exact agent hash + compatible durable identities are mandatory.
- Time compatibility uses versioned `CURSOR_USAGE_REGISTRY_TIME_CONTRACT_VERSION` and fixed `registryEventAttributionSlackMs` (initially equal to importer `INGESTION_SLACK_MS`).
- Slack validates compatibility but **never** selects the nearest run.
- More than one compatible run after slack → `registry_ambiguous`.
- Absence-based exclusion (`proven_outside_harness_scope`) requires the entire padded possible activity window inside a **sealed complete** coverage interval.

Explicit:

- Provider API is **not** the sole Apply authority.
- Absence from an incomplete/unsealed registry proves nothing.
- No historical unknown is manually backfilled.
- Historical source digests marked `historical_scope_unrecoverable` in the disposition manifest remain permanently non-Applyable.
- Apply detects overlapping raw late evidence from seal→tip independently of invalidation writers.
- Activation → history-proof commit → coverage-snapshot commit → seal (in-memory proofs are insufficient).

### Runner packaging

Snapshot includes `src/provenance/**` via existing `src/` include. Default mode remains `disabled`. Runner PR must pin final source SHA, snapshot digest, writer version, and launch-surface manifest digest — and remain unmerged until operator authorization.

### Production workflow wiring (operator config)

| Name | Kind | Purpose |
|------|------|---------|
| `P_DEV_CURSOR_PROVENANCE_MODE` | repository **variable** | `disabled` (default when unset/empty), `shadow`, or `required` |
| `P_DEV_PROVENANCE_KEY_V1` | repository **secret** | AES-256-GCM key material (32 bytes hex or base64url) |

Do **not** use `P_DEV_PROVENANCE_MODE` (obsolete / unused).

Wiring is **step-level only** on production Cursor validation/execution steps in [`.github/workflows/harness-auto-runner.yml`](../../.github/workflows/harness-auto-runner.yml):

- `run-harness` → `Doctor`, `Run harness`
- `run-merge` → `Doctor`, `Run merge` (merge may invoke Cursor via integration-repair)

Checkout, setup, install, build, gate, sync-production, reconcile-only, and evaluation/canary/probe workflows must not receive the encryption key.

Unset or empty mode resolves to `disabled`: no provenance state client, no encryption key required, no provenance network I/O. Workflow references may exist while the variable and secret remain absent.

**Operator rollout tooling:** `p-dev provenance <action>` / `npm run harness:provenance -- <action>` supports readiness, key generate/install (stdin/restricted file; never echoed), mode transitions, and coverage lifecycle actions (`quiet-window`, `activate`, `inspect-coverage`, `finalize`, `enumerate-seal-to-tip`). Coverage commands emit public-safe JSON only (no key material or provider identities). Fail closed on required-before-shadow and on incomplete coverage at finalize.

**Authorized live rollout order (when Build-authorized):**

1. Keep production capture on current runner main when capture code is unchanged
2. Add `P_DEV_PROVENANCE_KEY_V1` secret (retain after any provenance records exist)
3. Quiet-window across all production dispatch sources
4. Set `P_DEV_CURSOR_PROVENANCE_MODE=shadow` → planning-only canary
5. On success: `required` → activation record → required canary → persist history proof + coverage snapshot → seal
6. Importer Apply only inside sealed complete coverage (or synthetic disposable canary corpus)

Rollback is setting the mode variable back to `disabled` — do not rewrite state-repository history. At most one replacement shadow and one replacement required canary are authorized under the deterministic repair gates.

## Consequences

- Production phases cannot bypass the provenance wrapper (structural tests).
- Canaries/probes remain on the generic factory path.
- Crash windows after provider create and before ack are irreducible gaps unless later reconciled with authoritative evidence.
- Historical CSV Apply remains blocked via the disposition manifest (`historical_scope_unrecoverable`); future eligible CSVs require sealed complete coverage.
