# Issue: [Short title]

Assign the issue to a **mapped Linear project** (e.g. Example Target App) when possible. Routing is controlled by the **Linear status field** (e.g. Ready for Planning, Ready for Build), not by any section in this description.

Planning is **optional**. The human operator chooses Ready for Planning or Ready for Build by moving Linear status. Each issue must target **exactly one repository** and one coherent **PR-sized** outcome.

> `## Problem` is a parser fallback for `## Task`; prefer `## Task` for new issues.

## Target repo

owner/repo

_Include when known. May be copied from Linear project metadata (`Harness metadata: Target repo: ...`) or omitted when the issue is assigned to a mapped Linear project. Never put multiple repositories in one issue._

## Task

Concise description of the intended outcome. When material, include verified current behavior, the gap, the affected user or workflow, the current limiting constraint, requested system behavior, evidence-backed likely touchpoints, and important constraints. May be more than one or two sentences when needed. Do **not** turn this into a step-by-step implementation plan. Historical character-count heuristics are advisory only and do not control validity.

## Acceptance criteria

- [ ] Observable product outcome 1
- [ ] Observable product outcome 2

_Acceptance criteria describe observable results (user behavior, failure paths, edge cases, compatibility, integrity, security/privacy, observability, preserved behavior)—not that a file was edited or a library was used, unless that is itself a genuine product or architectural constraint._

## Out of scope

- Explicitly excluded work (adjacent findings declined, unrelated cleanup, other repositories, unauthorized production ops, future follow-ups)

## Validation expectations

Intake defines what proof will be required later. Do **not** claim implementation or tests have already passed.

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

_No load-bearing context may exist only in this section; put intent-critical information in Task, Acceptance criteria, Out of scope, and Validation expectations._

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
