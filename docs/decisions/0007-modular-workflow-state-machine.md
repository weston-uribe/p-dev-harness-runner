# ADR 0007: Modular workflow state machine

**Status:** Accepted (Chunk 4 foundation; Chunk 5 Plan Review loop; Chunk 6 Code Review loop)  
**Date:** 2026-07-18

## Context

Status routing was scattered across phase runners (`getTransitionalStatus` + hardcoded next statuses), reconcile modules, and GUI copy. Future optional Plan Review and Code Review agents need a reusable, provider-neutral workflow architecture without inventing per-phase `if` chains.

## Decision

### Why declarative

The product-development lifecycle is declared as a versioned workflow definition (`product-development-v2`) with phases, statuses, transitions, loop counters, and role bindings. Executable business logic stays in TypeScript modules (transition engine, reconcile adapters, runners) — not arbitrary config strings.

### Source-of-truth hierarchy

1. **Workflow definition** (versioned code + config) — legal transitions and role bindings
2. **Authoritative issue-scoped `WorkflowStateRecord`** — accepted phase/decision/counters/generations with monotonic `stateRevision`. On managed GitHub Actions runners this is durable GitHub Contents CAS on branch `p-dev-runtime-state` in an **explicit private state repository** (`P_DEV_WORKFLOW_STATE_REPOSITORY`), never in the public execution repository. Store mode is explicit (`P_DEV_WORKFLOW_STATE_STORE_MODE=managed_github`); local/fixture modes may use file or memory stores. Managed mode fails closed — never silently falls back to ephemeral local files or to `GITHUB_REPOSITORY`.
3. **Live Linear issue status + GitHub/run evidence** — external facts validated on every mutation
4. **Run manifests / Linear markers / status comments** — immutable snapshots or effect projections of durable decisions; must not independently advance workflow state
5. **Webhook/dispatch payloads** — hints only; never authorize transitions

### Decision-and-effects sequence

Accepted review decisions and handoff subjects are CAS-written to durable state with pending deterministic side effects (Linear comment, status transition, telemetry) before those external effects run. Each effect is CAS-marked complete; reconciliation replays only incomplete effects. Never post the authoritative decision comment or move Linear first and only afterward attempt to record the accepted decision.

### Atomic mutation protocol

Every state mutation must:

1. Read the latest authoritative state
2. Validate current Linear status and durable GitHub/run evidence
3. Include `expectedStateRevision`
4. Apply via compare-and-set **or** reject as stale/conflict
5. Increment `stateRevision` exactly once on accept
6. Use a deterministic transition/idempotency identity
7. Preserve monotonic counters and completed-phase evidence

When the backing store cannot provide true CAS, use bounded conflict detection with reread/retry (`stale_state` / `conflict_exhausted`).

### Status / phase / role separation

These identities are not interchangeable:

| Concept | Example |
|---------|---------|
| Linear status | `Building` |
| Workflow phase | `implementation` |
| Agent role | `builder` |
| Prompt role | `implementer` |
| Model role | `builder` |

Future `plan_reviewer` / `code_reviewer` roles do not require sharing names with statuses or prompts.

### Transition evaluation

`evaluateTransition` is the single evaluator for claim/success/failure/human/review/infra-retry outcomes. Phase runners resolve next statuses through this engine rather than inventing routing.

### Optional phases

Optional phases declare `enabledBy`, `bypassNext`, and do not require Linear statuses until enabled. When disabled:

- No agent run or Langfuse trace
- Bounded `phase_bypassed` event
- Continue to bypass destination
- No fake success scores

Defaults are split deliberately:

- `NEW_WORKSPACE_OPTIONAL_PHASE_DEFAULTS` — both `true` (first-run config builder persists this)
- `LEGACY_WORKFLOW_MIGRATION_DEFAULTS` — both `false` (configs with no `workflow` section)

Do not use one ambiguous constant for both behaviors.

### Mid-run setting changes

- A claimed phase execution keeps its frozen configuration (`phaseExecutionFreeze`).
- An issue already in Plan Review, Code Review, or Code Revision completes that active review loop under its frozen settings.
- Disabling a review prevents new claims after the save completes.
- Enabling a review affects subsequent eligible phase claims.
- Do not retroactively pull an issue backward into a review phase it has already passed.
- Do not cancel active agents merely because the global toggle changed.

### Review loops

Reusable `ReviewOutcome` / `ReviewDecision` contracts support approved, needs_revision, return-to-review, independent cycle counters, max escalation (no auto-approve), duplicate decision protection, and stale generation rejection. Reviewer agents are **not** implemented in this ADR’s chunk.

### Cycle limits

Counters are issue-scoped inside `WorkflowStateRecord`. Infrastructure retries, duplicate deliveries, and stale generations do not increment review counters. Plan-review and code-review counters are independent.

### Reconciliation

`resolveRoute` and reconcile CLIs read live Linear/GitHub evidence plus authoritative workflow state. Specialized revision/merge evaluators remain evidence adapters. The workflow definition determines eligibility shape; payloads do not.

### Linear migration

`workflow-status-report` produces a dry-run requirement report (missing/extra/category mismatches). It does not create or modify live statuses. Optional review statuses appear in the report only when enabled.

### Fail-closed Plan Review activation (Chunk 5)

Separate:

| Flag | Meaning |
|------|---------|
| `requestedEnabled` | `workflow.optionalPhases.planReview === true` |
| `effectiveEnabled` | Safe to execute: Linear Plan Review status present with required category, definition/prompt/skill/model valid, runner schema supported |

Until effective:

- Persist requested setting; GUI shows **Enabled — setup required** with exact missing requirements
- Production route remains **Planning → Ready for Build**
- No missing-status transition, no reviewer agent, no Plan Review trace/score
- Emit bounded `p_dev_plan_review_readiness` diagnostic (not a false preference-driven bypass)

Freeze **`effectiveEnabled`** (plus requested, cycle limit, model) into each claimed phase execution. Readiness/config changes apply only to subsequent claims.

### Plan Review lifecycle (when effective)

```text
Planning → Plan Review
  approved        → Ready for Build
  needs_revision  → Ready for Planning → Planning → Plan Review
  cycle limit     → Blocked (no auto-approve)
```

Default max cycles: **4**. Revision increments `plan_review_cycles` once; infra/duplicate/stale do not.

### Materiality and independence

Blocking findings only for meaningful risk (wrong behavior, missing outcome, unsafe migration, unverifiable acceptance, arch/security/privacy, material ambiguity). Style-only notes are nonblocking. Reviewer is a fresh agent with bounded context; harness owns status transitions.

### Plan artifact identity

Every plan generation persists `planGenerationId`, `planArtifactHash`, planner run id, prompt contract version, workflow-state revision, timestamps, and supersession links. Reviews must match harness evidence; model-claimed identity is insufficient.

### Mid-cycle configuration

Disabling Plan Review mid-cycle does not silent-bypass an active claimed reviewer. Final deployment cycle promotes requested → effective after Linear status migration and runner compatibility checks (out of Chunk 5 freeze for live migration).

### Extension procedure (Code Review)

Reuse the same pattern: optional phase + readiness gate + `ReviewOutcome` + independent counter + GUI three-state card. Do not invent parallel routing.

### Fail-closed Code Review activation (Chunk 6)

Separate three readiness layers (issue-independent vs per-issue):

| Flag | Meaning |
|------|---------|
| `requestedEnabled` | `workflow.optionalPhases.codeReview === true` |
| `configuredReady` | Safe to route/activate in GUI: Linear **Code Review** and **Code Revision** statuses present with required category, definition/prompt/skill/model valid, runner schema supported. **Does not require a PR.** |
| `executionEligible` | Per-issue: durable PR/implementation artifact matches live GitHub evidence (PR number, repo, head/base SHA, diff identity), generation not superseded, reviewer identity not already owning generation |

Until `configuredReady`:

- Persist requested setting; GUI shows **Setup required** (card state uses `configuredReady` only — not PR presence)
- Production route remains **PR Open → PM Review**
- No missing-status transition, no reviewer/reviser agent, no Code Review trace/score
- Emit bounded `p_dev_code_review_readiness` diagnostic (`configured_ready` property)

Per-issue gate failures emit `p_dev_code_review_execution_eligibility` (`execution_eligible` property). No diff/findings/code bodies in either event.

Freeze **`configuredReady`** (plus requested, cycle limit, reviewer/reviser models) into each claimed phase execution. Readiness/config changes apply only to subsequent claims.

### Code Review lifecycle (when configuredReady)

```text
PR Open → Code Review
  approved        → PM Review
  needs_revision  → Code Revision → Code Review
  cycle limit     → Blocked (no auto-approve)
```

Default max cycles: **4** (`workflow.cycleLimits.codeReview`). Revision increments `code_review_cycles` once; infra/duplicate/stale do not.

### vs PM / Engineering Review

Code Review is an **optional agent gate before PM Review**. PM Review and Engineering Review remain human gates on preview/behavior. Code Review evaluates implementation/PR materiality independently; it does not replace or share sessions with PM revision (`Needs Revision` → `Revising`).

### Independence and materiality

Code Reviewer is a fresh agent with bounded PR/diff context. Code Revision uses the **code reviser** role (defaults to Builder model) — separate from PM/engineering revision. Blocking findings follow the same materiality bar as Plan Review (meaningful risk only).

### PR / implementation artifact identity

Reviews bind to `implementationGenerationId`, PR number, repository, head/base SHA, and diff hash. Model-claimed identity is insufficient; live GitHub evidence must match durable artifacts at claim time.

### Code Revision vs PM Revising

| Path | Trigger | Agent role | Returns to |
|------|---------|------------|------------|
| Code Revision | Code Review `needs_revision` when Code Review configured | `code_reviser` | Code Review |
| Revising | PM/Engineering `needs_revision` | `builder` (same session policy as implementation) | PM Review |

### Mid-cycle configuration

Disabling Code Review mid-cycle does not silent-bypass an active claimed reviewer/reviser. Same freeze semantics as Plan Review.

### Linear requirements

When requested, Linear must expose **Code Review** and **Code Revision** statuses in the configured category (default `started`). Sync evaluation without Linear statuses treats statuses as missing (**fail-closed**).

### Engine reuse and Plan Review exception

Routing, `ReviewOutcome`, cycle counters, bypass events, and GUI optional-phase cards reuse the Plan Review pattern. **Exception:** Plan Review GUI/routing uses `effectiveEnabled`; Code Review uses `configuredReady` for card Active state and transition `effectiveOptionalPhases.codeReview` (execution eligibility is per-issue only).

## Consequences

- Current workflow behavior is preserved when Plan Review is not effectively enabled
- GUI shows Plan Review as Disabled / Setup required / Active
- GUI shows Code Review as Disabled / Setup required / Active (`configuredReady`)
- Markers/manifests become snapshots referencing `stateRevision` / transition identity
- Concurrent webhook/reconcile races are handled by atomic apply + bounded retry
