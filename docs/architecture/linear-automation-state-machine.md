# Linear automation state machine

**Status:** Partially implemented — statuses and labels configured manually in Linear; planning-router Cursor Automation validated (see research note 003). Implementation, revision, and merge/deploy automations remain planned.

This document defines the Linear issue lifecycle for the agentic product development harness. It is the contract for Cursor Automations.

**Related:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`docs/decisions/0003-automation-state-machine-and-auto-model-policy.md`](../decisions/0003-automation-state-machine-and-auto-model-policy.md), [`docs/research/002-linear-cursor-integration-smoke-test.md`](../research/002-linear-cursor-integration-smoke-test.md), [`docs/research/003-cursor-automation-planning-router-spike.md`](../research/003-cursor-automation-planning-router-spike.md)

---

## Default active workflow

The default path includes optional planning. `Plan Review` is **not** part of this flow.

```text
Backlog
  → Ready for Planning
  → Planning
  → Ready for Build
  → Building
  → PR Open
  → PM Review
  → Engineering Review
  → Merged / Deployed
```

### Revision loop

When PM review requests changes:

```text
PM Review
  → Needs Revision
  → Revising
  → PM Review
```

### Merge repair sub-states

Integration repair is a merge sub-mode, not a new top-level Linear phase. When a PR becomes `behind` or `dirty` after waiting in the serialized repo/base merge queue, the issue stays **Merging** while the runner attempts repair.

```text
Ready to Merge
  → Merging
    → repair_start
    → repair_deterministic
    → repair_agent_start (only if conflicts remain)
    → repair_complete
  → Merged to Dev / Merged / Deployed
```

If deterministic and agent repair fail, or the repair needs product judgment, the issue moves to **Blocked**. Successful repair returns directly to merge; it does not route back to PM Review solely because the PR branch changed.

### Planning bypass path

For low-risk, narrow, well-scoped issues that skip planning:

```text
Backlog
  → Ready for Build
  → Building
  → PR Open
  → PM Review
  → Engineering Review
  → Merged / Deployed
```

Issues on the bypass path join the default flow at **Building** and follow the same review and merge stages.

---

## Terminal and exception statuses

| Status | Meaning |
|--------|---------|
| **Blocked** | Work cannot proceed; requires human intervention |
| **Canceled** | Issue abandoned; no further automation |
| **Duplicate** | Superseded by another issue; no further automation |

Automations must **exit without action** when an issue is in one of these statuses unless explicitly designed for cleanup (not planned in the first spike).

---

## Deprecated: Plan Review

`Plan Review` is **not** part of the default or current automation path.

- If the status still exists in Linear, treat it as **deprecated / reserved**, not active.
- Do not route automations to `Plan Review`.
- Plan review may be reintroduced later for high-risk work; that is out of scope for the current spike.

---

## Planning policy

Planning is **optional**, not mandatory for every issue.

| Label | Behavior |
|-------|----------|
| `requires-plan` | Issue must go through **Ready for Planning** → **Planning** before **Ready for Build** |
| `skip-plan` | Issue may go directly from **Backlog** to **Ready for Build** |

### When to require planning

Require planning (via `requires-plan` or human triage) when the issue is:

- Broad or ambiguous in scope
- High-risk (security, data, auth, payments, infra)
- Multi-file or cross-cutting
- Unclear on acceptance criteria or rollback

### When to bypass planning

Bypass planning (via `skip-plan` or direct **Ready for Build**) when the issue is:

- Small and low-risk
- Narrow and well-scoped
- Has clear acceptance criteria in the Linear issue body

For bypass issues, the **Implementation Agent** may build directly from the Linear issue without a separate plan artifact. The issue description and acceptance criteria are the durable input.

### Uninitialized product routing

When the target repository marker on the **development branch** (`repos[].baseBranch`, usually `dev`) reports `Product initialization: uninitialized`:

- Issues with `## Product foundation` route to **Ready for Planning** for stack selection and foundation planning.
- Direct **Ready for Build** routing is blocked until approved architecture exists and the marker reads `initialized`.
- After foundation merge to `dev`, the merge workflow updates Linear project metadata to `Product initialization: initialized` idempotently.

Application preview/deployment capability is **not** inferred from the marker. Harness `repos[].previewProvider` is the sole runtime authority (`vercel` or `none`).

### Planning agent output

When planning runs:

1. The **Planning Agent** reads the Linear issue and repo context.
2. It posts a **durable plan comment** in Linear (structured per [`templates/implementation-plan.md`](../../templates/implementation-plan.md)).
3. It moves the issue to **Ready for Build** only after the plan comment exists.

Automations must **not** advance status to **Ready for Build** without a durable plan comment when `requires-plan` is set.

---

## Cursor model policy

| Rule | Detail |
|------|--------|
| **Preferred future policy** | **`Auto`**, if Cursor Automations support it as a model setting |
| **Current automation policy** | **Composer 2.5** — required because Cursor Automations currently need a concrete model selection and `Auto` is not available |
| **Mid-run switching** | **Disallowed** — agents must not change models during a run |
| **Documentation** | Reports, comments, and automation output must state the **actual configured model**, not a preferred policy |
| **Future flexibility** | Harness docs and prompts should be written so the model setting can change later without rewriting workflows |

---

## Router automation design

Cursor Automations should use a **router** pattern, not many independent automations per status.

### Why a router

- **Broad Linear status-change triggers are expected** — automations fire on any status transition, not only the intended one.
- The router must inspect issue **status and labels first** before acting.
- **Non-matching runs must exit silently** — no branch, no PR, no Linear comments, no status writes.
- **Duplicate self-triggered runs are acceptable only if silent** — when the automation moves an issue through **Planning** or **Ready for Build**, each transition re-fires the trigger; those runs must no-op without Linear noise.

Validated in WES-9 and WES-10 — see [`docs/research/003-cursor-automation-planning-router-spike.md`](../research/003-cursor-automation-planning-router-spike.md).

### Router behavior

| Issue status | Action |
|--------------|--------|
| **Ready for Planning** | Run planning flow (Planning Agent) |
| **Ready for Build** | Run implementation flow (Implementation Agent) — **not yet validated** |
| **Needs Revision** | Run revision flow (Builder follow-up) — **implemented** |
| Any other status | **Silent exit** — no changes, no Linear writes |

The router may delegate logically to role-specific prompts. The planning spike implements this as **one Cursor Automation prompt** that routes based on Linear status.

### Planning run output

A successful planning run must post **exactly one combined planning/report comment** in Linear before moving the issue to **Ready for Build**. Duplicate or non-matching runs must not add comments.

### Spike scope

The **planning-router spike is validated** (WES-9 + WES-10). The next spike is **implementation automation** — docs-only, starting from **Ready for Build**, creating a branch and PR, moving Linear to **PR Open** or **PM Review**. No revision loop yet.

---

## Agent roles

Role maturity varies — see honest maturity table below. Planning Agent behavior is validated; other roles remain planned.

### Router Agent

| Field | Detail |
|-------|--------|
| **Trigger / status** | Linear status change (any); acts only on supported statuses above |
| **Input** | Linear issue (status, labels, title, description, comments) |
| **Output** | Delegation to Planning, Implementation, or Revision flow; or clean exit |
| **Linear writes** | None directly — may update status only when sub-flow completes (via delegated agent) |
| **GitHub writes** | None |
| **Must not do** | Run build or planning on unsupported statuses; write Linear comments on no-op exit; merge PRs |

### Planning Agent

| Field | Detail |
|-------|--------|
| **Trigger / status** | **Ready for Planning** (via router) |
| **Input** | Linear issue, target repo context, existing comments |
| **Output** | Durable plan comment in Linear |
| **Linear writes** | Plan comment; move to **Ready for Build** after plan exists; move to **Planning** while working if status model requires it |
| **GitHub writes** | None |
| **Must not do** | Implement code; open PRs; skip plan comment; post duplicate comments on re-triggered runs |

### Implementation Agent

| Field | Detail |
|-------|--------|
| **Trigger / status** | **Ready for Build** (via router) |
| **Input** | Linear issue, plan comment (if `requires-plan`), repo context |
| **Output** | Feature branch, commits, PR; readiness summary in Linear comment |
| **Linear writes** | Progress comments; move to **Building** while working; move to **PR Open** when PR exists |
| **GitHub writes** | Branch, commits, PR (link back to Linear issue) |
| **Must not do** | Merge PRs; deploy without human gate; advance past **PR Open** without a PR |

### Builder (implementation, revision, repair)

| Field | Detail |
|-------|--------|
| **Trigger / status** | **Ready for Build** (create); **Needs Revision** (resume follow-up); **Merging** agent repair (resume follow-up when deterministic repair is insufficient) |
| **Input** | Linear issue, plan comment (if `requires-plan`), repo context; revision adds PM feedback; repair adds PR/check context |
| **Output** | Feature branch, commits, PR (implementation); additional commits and revision summary (revision); repair commits or summary (agent repair) |
| **Linear writes** | Hidden metadata: `builder_agent_id`, `builder_thread_generation`, `builder_thread_action`, `builder_origin_run_id`, `builder_thread_idempotency_key`, and replacement fields when applicable; phase-specific `cursor_agent_id` / `cursor_run_id` remain as Cursor evidence |
| **GitHub writes** | Branch, commits, PR (implementation); commits on existing branch (revision / repair) |
| **Must not do** | Merge PRs; create a separate revision or repair cloud agent when lineage can be resumed; replace Builder on transient resume or uncertain-send failures |

Implementation creates generation `1`. Revision and agent repair resolve the canonical Builder from durable Linear metadata, call `Agent.resume` (unarchive when needed), and send follow-up prompts with stable idempotency keys. Replacement Builders are created only for definitive agent loss or exhausted legacy lineage.

### Revision Agent (deprecated role name)

The historical **Revision Agent** label referred to a separate Cursor cloud agent. Current behavior uses the **Builder** thread resumed from handoff / implementation markers. Docs and prompts may still say "revision" for the phase, but there is no independent revision agent role.

### Merge / Deployment Reporter

| Field | Detail |
|-------|--------|
| **Trigger / status** | **Merged / Deployed** (manual or post-merge hook — not in first spike) |
| **Input** | Merged PR, deployment URL (e.g. Vercel preview/production) |
| **Output** | Final status comment with links and evidence |
| **Linear writes** | Closure comment with PR merge link and preview/production URL |
| **GitHub writes** | None (read-only) |
| **Must not do** | Trigger merges |

---

## Durable context principle

Automations and agents must treat **durable artifacts** as the source of truth.

| Principle | Detail |
|-----------|--------|
| **Durable state required** | Linear comments, GitHub PR/commits/branch, Vercel preview URLs, and issue fields must hold enough context to resume work |
| **Session reuse is optional** | Resuming the canonical Builder via Cursor `Agent.resume` is the happy path when lineage is valid |
| **Fresh agent recovery** | A replacement Builder (or Planner for planning-only work) must always be able to reconstruct context from Linear, GitHub, branch, PR, commits, Vercel preview, and Linear comments |
| **No hidden memory** | Hidden agent or session memory must **never** be the source of truth |

Before advancing Linear status, the agent must ensure the required durable artifact exists (plan comment, PR link, revision summary, etc.).

---

## Honest maturity

| Item | Status |
|------|--------|
| Linear statuses and labels | **Configured manually** in Linear |
| Native Cursor ↔ Linear trigger | **Smoke-tested once** — see research note 002 |
| Planning-router Cursor Automation | **Validated** — see research note 003 (WES-9, WES-10) |
| Implementation automation | **Planned** — next spike |
| Revision loop automation | **Planned** |
| Merge/deploy reporting automation | **Planned** |
| Full autonomous build loop | **Not planned** |
| Automation model | **Composer 2.5** (current); **`Auto` preferred** when supported |
