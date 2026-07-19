# Spike: Cursor Automation planning router

**Linear issues:** [WES-9 — Planning router automation spike](https://linear.app/issue/WES-9), [WES-10 — Idempotent router fix](https://linear.app/issue/WES-10)  
**Target repo:** [`agentic-product-development-harness`](https://github.com/weston-uribe/agentic-product-development-harness)  
**Date:** 2026-07-06  
**Outcome:** Planning-router Cursor Automation validated; idempotent silent no-op behavior confirmed.

This note records a **Cursor Automations spike**, not production automation. Implementation, revision, and merge/deploy automations remain **planned**.

---

## What was tested

Whether a Linear status-change Cursor Automation can:

1. Trigger on Linear issue status changes
2. Authenticate to Linear MCP inside the automation environment
3. Read and write Linear issues (comments, status transitions)
4. Route on issue status and exit silently when the status does not match
5. Run the planning flow: **Ready for Planning** → **Planning** → **Ready for Build** with a durable planning comment

---

## WES-9 — Initial planning router spike

### Result

| Criterion | Result |
|-----------|--------|
| Linear status-change trigger fires automation | Pass |
| Linear MCP auth inside automation environment | Pass |
| Issue read (status, labels, title, description, comments) | Pass |
| Issue write (status transition, comment) | Pass |
| Status path: Ready for Planning → Planning → Ready for Build | Pass |
| Durable planning comment posted | Pass |

### Issue discovered

Broad Linear status-change triggers caused **duplicate automation runs**. When the automation moved the issue through **Planning** and **Ready for Build**, each status transition re-fired the trigger, producing duplicate runs and extra Linear comments.

---

## WES-10 — Idempotent router fix

### Result

| Criterion | Result |
|-----------|--------|
| Router inspects current status before acting | Pass |
| Non-matching / duplicate runs exit silently | Pass |
| No Linear comments written on no-op exit | Pass |
| Successful planning run posts one combined planning/report comment | Pass |

The quiet router pattern works: duplicate or self-triggered runs are acceptable **only when they exit without Linear writes**.

---

## Model configuration reality

Cursor Automations currently require a **concrete model selection**. **`Auto` is not available** as an automation model setting at the time of this spike.

| Setting | Policy |
|---------|--------|
| **Current automation model** | **Composer 2.5** — configured on the planning-router automation |
| **Preferred future policy** | **`Auto`**, if Cursor Automations support it |
| **Mid-run model switching** | **Disallowed** — agents must not change models during a run |
| **Documentation** | Reports and comments must state the **actual configured model**, not a preferred policy |

---

## What is now validated

- Linear status-change trigger
- Linear MCP authentication inside automation environment
- Linear issue read/write (comments, status transitions)
- Status transition path: **Ready for Planning** → **Planning** → **Ready for Build**
- Durable planning comment on successful planning run
- Silent no-op behavior for duplicate and non-matching runs (no Linear comment noise)

---

## What is not yet validated

- Implementation automation (build from **Ready for Build**)
- Branch creation from automation
- PR creation from automation
- Revision loop (**Needs Revision** → **Revising** → **PM Review**)
- Merge/deploy reporting automation

---

## Scope boundaries (honored)

- Harness repo documentation only for this note
- No changes to `example-target-app` or other target repos
- No new skills under `skills/` (canonical skills now live under `.agents/skills/`)
- No releases or version bumps
- No implementation code or CI changes

---

## Honest maturity statement

The **planning-router** Cursor Automation spike is **validated** as of 2026-07-06 (WES-9 + WES-10). A **single** planning automation exists in Cursor; implementation, revision, and merge/deploy automations remain **planned** per [`ROADMAP.md`](../../ROADMAP.md).
