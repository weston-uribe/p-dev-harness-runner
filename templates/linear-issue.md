# Issue: [Short title]

Assign the issue to a **mapped Linear project** (e.g. Example Target App) when possible. Routing is controlled by the **Linear status field** (e.g. Ready for Planning, Ready for Build), not by any section in this description.

> `## Problem` is a parser fallback for `## Task`; prefer `## Task` for new issues.

## Target repo

owner/repo

_Include when known. May be copied from Linear project metadata (`Harness metadata: Target repo: ...`) or omitted when the issue is assigned to a mapped Linear project._

## Task

Single clear objective in one or two sentences.

## Acceptance criteria

- [ ] Observable product outcome 1
- [ ] Observable product outcome 2

## Out of scope

- Explicitly excluded work

## Validation expectations

### Automated checks

- Known lint/build/test expectations, or unknown / planner to resolve

### Behavioral acceptance verification

- Observable steps that exercise each acceptance criterion in a representative runnable environment
- Or: Planner must determine the representative runtime verification method.

### Regression checks

- Important preserved behavior that must still work

### Required evidence

- What handoff should include (command output, request/response summary, browser result, screenshot when visual, before/after reproduction)

## Context and links

- Related issues / PRs:
- Design or research links:
- Target repo: `owner/repo` (optional backup if `## Target repo` is omitted)

## User / job story

As a **[persona]**, I want **[capability]** so that **[outcome]**.

## Eval hints

| Criterion | Priority |
|-----------|----------|
| Matches acceptance criteria | Required |
| No unrelated file changes | Required |

## Definition of ready

- [ ] Task and acceptance criteria are clear
- [ ] Out of scope is documented
- [ ] Validation expectations define required proof (or planner placeholder)
- [ ] Linear project assigned (or target repo identified)
- [ ] PM / owner assigned for review
