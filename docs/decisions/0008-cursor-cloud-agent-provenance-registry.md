# ADR 0008: Cursor Cloud Agent provenance registry (Linear-harness capture)

**Status:** Accepted (capture-only foundation)  
**Date:** 2026-07-22

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

**Existing operational plaintext identity surfaces** (out of scope for this capture-only change; documented for honest privacy verdicts):

- Linear harness markers / phase-start comments that may include `cursorAgentId` / `cursorRunId`
- Workflow and builder continuity state used for resume
- Local run manifests, event logs, and Cursor run-observer telemetry under `runs/`
- Existing Cursor event log lines such as `cursor_agent_created`

Privacy verdicts for this feature are scoped to the provenance event store and public-safe provenance diagnostics — not a claim that no plaintext ID exists anywhere in the harness.

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

### Future importer integration (deferred)

Importer must **not** consume the registry in this cycle. Future join contract:

`agentHash + exact registry execution window` (exactly one eligible binding; no nearest-timestamp).

Explicit:

- Provider API is **not** the sole Apply authority.
- Absence from an incomplete registry proves nothing.
- No historical unknown is manually backfilled.
- Current real import remains unsafe to Apply.

### Runner packaging

Snapshot includes `src/provenance/**` via existing `src/` include. Default mode remains `disabled`. Runner PR must pin final source SHA, snapshot digest, writer version, and launch-surface manifest digest — and remain unmerged until operator authorization.

## Consequences

- Production phases cannot bypass the provenance wrapper (structural tests).
- Canaries/probes remain on the generic factory path.
- Crash windows after provider create and before ack are irreducible gaps unless later reconciled with authoritative evidence.
- Historical CSV Apply remains blocked until a future complete closed coverage epoch exists and importer consumption is implemented separately.
