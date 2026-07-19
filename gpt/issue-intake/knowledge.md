# Harness-compatible Linear issue intake — knowledge reference

This document is the authoritative contract for drafting Linear issues that work with AI-assisted product development workflows. Use it when interviewing a product manager, assembling an issue package, or assessing readiness before creation.

---

## Purpose

A harness-compatible Linear issue captures **product intent in a structured, reviewable form** before any code is written. The issue description is the durable input for planning and implementation agents. It must be clear enough that a fresh agent—with no hidden session memory—can understand scope, success criteria, and boundaries from the issue alone.

---

## Routing model

**What happens next is controlled by the Linear status field—not by any section in the issue description.**

Set the recommended status on the issue when creating or updating it. Do not add a "routing recommendation," "recommended status," or similar section inside the description body.

### PM-facing status glossary

| Status | Meaning |
|--------|---------|
| **Backlog** | Work is captured but not ready to trigger automation. Use when open questions remain or the user has not approved a higher status. |
| **Ready for Planning** | Triggers a planning workflow. Use for broad, ambiguous, cross-cutting, or high-risk work that needs a plan before implementation. |
| **Ready for Build** | Triggers direct implementation. Use only for narrow, low-risk issues with clear acceptance criteria (see narrow thresholds below). |
| **Draft only** | Produce the issue package only; do not create a Linear issue until the user explicitly approves later. |

Statuses like Planning, Building, PR Open, PM Review, and Merged / Deployed are set by automation during execution—do not recommend them at intake.

---

## Description contract

Issue descriptions use **level-2 markdown headers** (`##`). Section names are case-insensitive when parsed.

### Required sections

| Section | Content |
|---------|---------|
| `## Target repo` | GitHub repository where work happens (see formats below) |
| `## Task` | Single clear objective in one or two sentences |
| `## Acceptance criteria` | At least one hyphen bullet; observable product outcomes |
| `## Out of scope` | At least one hyphen bullet; explicitly excluded work |
| `## Validation expectations` | Required for new intake; Automated checks, Behavioral acceptance verification (or planner placeholder), Regression checks, Required evidence |

### Optional sections

- `## Context and links` — related issues, designs, research links
- `## User / job story` — persona, capability, outcome
- `## Eval hints` — evaluation priorities for reviewers
- `## Definition of ready` — checklist before work starts

### Formatting rules

- **Acceptance criteria** and **Out of scope** must use hyphen bullets (`-`). Checkbox bullets (`- [ ]`) are allowed and treated as list items.
- Prefer `## Task` over `## Problem`. `## Problem` is accepted as a fallback for Task but should not be used in new issues.
- Do not nest required sections under other headers.
- Keep the Task section concise; put detail in acceptance criteria or context.

### Anti-patterns (do not include in descriptions)

- A routing or status recommendation section inside the body
- Vague acceptance criteria ("works well," "looks good")
- Empty or missing out-of-scope section
- Invented target repos or workspaces
- Internal automation jargon (webhooks, orchestrator markers, runner phases, etc.)

---

## Target repo formats

Accepted formats for `## Target repo`:

- `owner/repo` (e.g. `acme-corp/checkout-web`)
- `github.com/owner/repo`
- `https://github.com/owner/repo`

The repo must be a real GitHub repository the team intends to change. Never invent or guess a repo. If the user is ambiguous ("the main app," "our API"), ask a blocking question before finalizing.

---

## Direct implementation eligibility (narrow thresholds)

Direct implementation without a prior planning step is appropriate **only** when all of the following are true:

1. **Task length** — `## Task` body is **240 characters or fewer** (including spaces)
2. **Acceptance criteria count** — **7 or fewer** hyphen bullets under `## Acceptance criteria`
3. **Scope** — Low-risk and clear: no auth, payments, security-sensitive changes, multi-repo work, or ambiguous boundaries

If any threshold fails, or scope is broad/ambiguous/high-risk, recommend **Ready for Planning** or **Backlog**—never Ready for Build.

### High-risk signals (planning-first)

- Security, authentication, or authorization changes
- Payments or billing
- Data migrations or schema changes
- Infrastructure or multi-service changes
- Cross-cutting UI or information-architecture redesigns
- Unclear or disputed acceptance criteria

---

## Readiness assessment algorithm

Perform this assessment for every completed issue package. This is a **structural** check only—it does not verify that a repo exists on an operator allowlist.

### Valid for planning: yes/no

**Yes** when all of the following hold:

- `## Target repo` is present and identifiable (not empty, not invented)
- `## Task` (or `## Problem`) is present and non-empty
- `## Acceptance criteria` has at least one hyphen bullet
- `## Out of scope` has at least one hyphen bullet

**No** when any required section is missing or empty. State which sections failed.

### Valid for direct implementation: yes/no

**Yes** when:

- Valid for planning is **yes**, AND
- Task length ≤ 240 characters, AND
- Acceptance criteria count ≤ 7, AND
- Scope is low-risk and clear (no high-risk signals above)

**No** otherwise. Include a reason string, e.g.:

- `task length 312 exceeds 240 characters`
- `acceptance criteria count 8 exceeds 7`
- `scope is broad or high-risk; planning recommended`
- `missing required section: Out of scope`

---

## Labels (optional)

Labels are operational hints only. They are **never required** for a valid issue.

| Label | Meaning |
|-------|---------|
| `requires-plan` | Should go through planning before build |
| `skip-plan` | May bypass planning if status is Ready for Build |
| `harness` | Work uses the agentic development harness |
| Repo id label | Short identifier for the target repo (team convention) |

Suggest labels only when they add clarity. Omit if the user's workspace does not use them.

---

## Example 1 — Narrow issue (Ready for Build candidate)

**Title:** Add order confirmation toast on checkout success

**Recommended status:** Backlog (default until user approves Ready for Build)

**Optional labels:** `harness`, `checkout-web`, `skip-plan`

**Target repo:** acme-corp/checkout-web

### Readiness assessment

- Valid for planning: yes — all required sections present
- Valid for direct implementation: yes — task 58 characters, 3 acceptance criteria, low-risk UI change

### Blocking questions

- none

### Linear description (copy-paste)

```markdown
## Target repo

acme-corp/checkout-web

## Task

Show a success toast when the customer completes checkout.

## Acceptance criteria

- [ ] A toast appears within 2 seconds of successful payment
- [ ] Toast message includes the order confirmation number
- [ ] Toast auto-dismisses after 5 seconds

## Out of scope

- Email confirmation changes
- Payment provider integration changes
- Other pages or flows

## Validation expectations

### Automated checks

- Lint and build pass when known for this repo

### Behavioral acceptance verification

- Complete a successful checkout on staging and confirm the toast appears within 2 seconds
- Confirm the toast shows the order confirmation number
- Confirm the toast auto-dismisses after about 5 seconds

### Regression checks

- Failed payment still shows the existing error path without a success toast

### Required evidence

- Staging checkout steps and observed toast behavior
```

---

## Example 2 — Broad issue (Ready for Planning)

**Title:** Redesign checkout navigation and information architecture

**Recommended status:** Ready for Planning

**Optional labels:** `harness`, `checkout-web`, `requires-plan`

**Target repo:** acme-corp/checkout-web

### Readiness assessment

- Valid for planning: yes — all required sections present
- Valid for direct implementation: no — task length 142 characters OK but acceptance criteria count 8 exceeds 7; cross-cutting IA change is high-risk

### Blocking questions

- none

### Linear description (copy-paste)

```markdown
## Target repo

acme-corp/checkout-web

## Task

Redesign checkout navigation and information architecture so customers can complete purchase, review order details, and access support without confusion.

## Acceptance criteria

- [ ] Primary nav reflects the new IA across checkout steps
- [ ] Mobile nav matches desktop destinations
- [ ] Cart is reachable in one click from any checkout step
- [ ] Order summary is reachable in one click from payment step
- [ ] Support/help link is visible on every checkout step
- [ ] No broken internal links after restructure
- [ ] Preview looks correct on mobile and desktop
- [ ] Lint and build pass

## Out of scope

- Payment provider integration changes
- New CMS integration
- Backend API redesign

## Validation expectations

### Automated checks

- Lint and build pass

### Behavioral acceptance verification

- Planner must determine the representative runtime verification method.

### Regression checks

- Existing checkout payment completion path still works

### Required evidence

- Preview or staging navigation walkthrough results
```

---

## Synthesizing Task from intake fields

When assembling an issue from the upfront intake form:

1. **Desired outcome** — what success looks like for the user or business
2. **Current problem / current behavior** — what is wrong or missing today
3. **Requested change** — what should be built or changed

Combine fields 2–4 into a concise `## Task` (one or two sentences). Put measurable outcomes in `## Acceptance criteria`. Put boundaries in `## Out of scope`.

---

## Default behavior summary

| Setting | Default |
|---------|---------|
| Recommended status | Backlog |
| Create Linear issue | Only after user approves the final package |
| Ready for Planning / Ready for Build | Recommend only after explicit user approval of status |
| Labels | Optional; suggest only when useful |
| Follow-up questions | Only when required information is missing or ambiguous |
