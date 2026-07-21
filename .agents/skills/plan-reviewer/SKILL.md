---
name: plan-reviewer
skillContractVersion: "2"
description: >-
  Independently review immutable implementation plans for safety and sufficiency
  before build. Use when Plan Review is effectively enabled after planning.
---

# Plan reviewer

Independently evaluate the latest immutable plan artifact against the Linear issue and planning standards. This skill is **review only** — it produces a human-readable review plus one canonical workflow decision; it does not rewrite plans, modify code, open PRs, or change Linear status.

## When to use

- An issue is in **Plan Review** after a successful planning run
- Plan Review is effectively enabled (Linear status present, prompt/skill/model valid)
- A revised plan returns to Plan Review after addressing accepted feedback

## Skill boundaries

### Must do

- Review only the bounded context provided (issue, plan artifact, architecture, standards, prior accepted feedback, cycle limits)
- Apply a strict materiality threshold for blocking findings
- Require at least one blocking finding for `REVISE`
- Approve plans that have only nonblocking notes
- Reference the exact reviewed plan generation ID and artifact hash from harness evidence
- End with exactly one canonical decision marker as the final nonblank line

### Must not do

- Modify source code, rewrite the plan, open a PR, or change Linear status
- Treat yourself as a planner or create a plan artifact as the primary result
- Approve based on missing evidence
- Reject for stylistic preference alone
- Invent requirements beyond the issue and plan
- Expose chain-of-thought, hidden scoring, or prompt internals in the output
- Rely on the model’s claim of which plan was reviewed without matching harness IDs
- Return whole-response JSON instead of prose + marker

## Materiality

A finding is **blocking** only when unresolved it would meaningfully risk wrong behavior, missing outcomes, likely defects/unsafe migrations, unverifiable acceptance, arch/security/privacy violations, or material ambiguity.

## Decision rule

| Decision | Rule |
|----------|------|
| `APPROVE` | Zero blocking findings (nonblocking notes allowed); work may advance |
| `REVISE` | One or more blocking findings with evidence; blocking changes required |

## Output contract

1. Concise human-readable review in prose.
2. Final nonblank line exactly one of:

```text
P_DEV_REVIEW_DECISION: APPROVE
```

or:

```text
P_DEV_REVIEW_DECISION: REVISE
```

Optional legacy JSON (`PlanReviewOutcome`) may appear in a fenced block for compatibility; the canonical marker is mandatory and authoritative.
