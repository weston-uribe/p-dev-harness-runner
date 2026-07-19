---
name: issue-intake
skillContractVersion: "1"
description: >-
  Turn a fuzzy product idea into a harness-compatible Linear issue. Use when
  starting new harness work, drafting Linear issues, or validating issue
  readiness before planning or implementation.
---

# Issue intake

Turn a fuzzy product idea into a harness-compatible Linear issue. Routing is controlled by the **Linear status field**, not by any section in the issue description.

## When to use

- Starting new harness work from an unstructured idea (in Cursor)
- Re-intaking or refining a draft issue before validation
- Operator-assisted intake when ChatGPT is not available

For PM self-service intake, use the canonical ChatGPT prompt — see [ChatGPT path](#chatgpt-path) below.

## Intake rules

### Upfront form (default)

Ask for **all fields in one message**:

1. **Linear project** (primary) — e.g. Example Target App, Agentic Product Development Harness
2. **Target repo** (optional override) — only when project metadata does not include `Harness metadata: Target repo: ...`
3. Desired outcome
4. Current problem / current behavior
5. Requested change
6. Acceptance criteria or observable success
7. Out of scope / what not to change
8. Validation expectations — what proof will be required later (outcome-oriented; see below)
9. Initial Linear status preference: Backlog | Ready for Planning | Ready for Build | Draft only

**Defaults:** status → Backlog; do not finalize for Linear paste until the operator approves the package.

### Follow-up questions

Ask follow-ups **only** when required information is missing or ambiguous. Do not interview one question at a time by default.

### Synthesis

Combine fields 3–5 into `## Task`. Put measurable outcomes in `## Acceptance criteria`. Put boundaries in `## Out of scope`. Translate field 8 into structured `## Validation expectations` (proof required later — not a claim that tests already passed).

### Validation expectations (required for new intake packages)

Intake defines **what proof will be required later**. Do not invent technical commands or claim verification has already passed.

Use product-language outcomes such as:

- “Open the homepage and confirm the toggle appears after Contact.”
- “Switch both themes and verify text and controls remain readable.”
- “Submit a valid and invalid request and verify the documented responses.”
- “Reproduce the reported failure and confirm the same steps now succeed.”

Structure `## Validation expectations` with these subsections (bullets under each):

1. **Automated checks** — known lint/build/test expectations, or “unknown / planner to resolve”
2. **Behavioral acceptance verification** — observable steps that exercise each acceptance criterion in a representative runnable environment. When the method is unknown, use exactly: `Planner must determine the representative runtime verification method.`
3. **Regression checks** — important preserved behavior that must still work
4. **Required evidence** — what handoff should include (e.g. command output, request/response summary, browser result, screenshot when visual state matters, before/after reproduction)

**Behavioral acceptance verification** means directly exercising the implemented behavior in a representative runnable environment and collecting objective evidence that acceptance criteria are satisfied. It is distinct from static inspection, typecheck, lint, compilation, or unit tests alone.

Do not invent technical implementation commands during intake. The PM may not know tooling; keep expectations outcome-oriented.

### Push back

Stop and narrow when: multi-repo scope, security/auth/payments, vague AC, no observable success, or AC count likely >7 without planning.

## Status recommendation

Recommend **Linear status** (not a description section):

| Condition | Recommended status |
|-----------|-------------------|
| Blocking questions remain | Backlog |
| User chose Draft only | Package only |
| Structurally incomplete | Backlog |
| Narrow + low-risk (task ≤240 chars, AC ≤7) | Ready for Build only after operator confirms |
| Broad, ambiguous, cross-cutting, or high-risk | Ready for Planning or Backlog |
| Uninitialized product (metadata or marker) | Ready for Planning only |
| Default | Backlog |

**Never** recommend Ready for Build for broad or ambiguous work.

### Labels (optional)

Use only **existing** WES team labels. Suggest: `target-app` / `harness` by project; `requires-plan` + `planning-agent` for Ready for Planning; `skip-plan` + `implementation-agent` for Ready for Build; `Feature`/`Improvement`/`Bug` when obvious. Runner does not enforce labels.

### Project metadata

Read Linear project description for:

```text
Harness metadata:
Target repo: owner/repo
Product initialization: uninitialized | initialized
```

Copy derived repo into `## Target repo` in the issue description.

### Uninitialized products

When project metadata reports `Product initialization: uninitialized` (or the target repo marker on the development branch is uninitialized):

- Recommend **Ready for Planning** for the first foundation issue.
- **Never** recommend Ready for Build until the product is initialized.
- For foundation planning issues, include optional `## Product foundation` with at least:
  - `Platform runtime: ...`
  - `Language framework: ...`

## Narrow-issue thresholds (build-direct)

Direct implementation without a prior planning run requires:

- Task body ≤ 240 characters
- Acceptance criteria ≤ 7 hyphen bullets
- Low-risk, clear scope

See [`src/validate/constants.ts`](../../../src/validate/constants.ts) for canonical values. Full rules in [`prompts/issue-intake-chatgpt.md`](../../../prompts/issue-intake-chatgpt.md).

## Output package

Produce this artifact when intake is complete:

```markdown
# Proposed Linear issue

**Title:** ...
**Recommended status:** Backlog | Ready for Planning | Ready for Build
**Recommended labels:** ... (existing labels only)

## Linear description

<paste-ready markdown matching description contract>
```

Apply the readiness assessment algorithm from [`prompts/issue-intake-chatgpt.md`](../../../prompts/issue-intake-chatgpt.md) internally — do not include it in the final package.

## Description contract

Required sections (level-2 headers, case-insensitive):

- `## Target repo` — include when known; may be derived from Linear project metadata
- `## Task` (preferred; `## Problem` is a parser fallback)
- `## Acceptance criteria` — at least one `-` bullet; product outcomes, not implementation procedures
- `## Out of scope` — at least one `-` bullet
- `## Validation expectations` — required for new intake packages; structured as Automated checks, Behavioral acceptance verification (or planner-resolution placeholder), Regression checks, and Required evidence

Optional: `## Context and links`, `## Product foundation`, `## User / job story`, `## Eval hints`, `## Definition of ready`

Note: the Linear description parser still treats `## Validation expectations` as optional for legacy issues. New intake must always include it.

Authoritative copy: [`prompts/issue-intake-chatgpt.md`](../../../prompts/issue-intake-chatgpt.md)

## ChatGPT path

PMs copy the canonical prompt into a normal ChatGPT thread:

1. Open [`prompts/issue-intake-chatgpt.md`](../../../prompts/issue-intake-chatgpt.md) and copy the entire file into ChatGPT
2. Answer the upfront intake form; review the proposed Linear issue
3. Approve creation; ChatGPT creates via Linear access if available, otherwise create manually in Linear with the recommended status and labels
4. Operator optionally validates live issues with CLI (below)

Deferred Custom GPT setup: [`gpt/issue-intake/setup-guide.md`](../../../gpt/issue-intake/setup-guide.md)

## Cursor validation path

After producing or pasting a description, instruct the operator to run route-specific validation:

```bash
# Recommended Ready for Planning
npm run harness:validate-issue -- --file <draft.md> --intended-phase planning

# Recommended Ready for Build
npm run harness:validate-issue -- --file <draft.md> --intended-phase implementation

# General check (both routes reported; exit 0 if planning-valid)
npm run harness:validate-issue -- --file <draft.md>
```

After paste to Linear:

```bash
npm run harness:validate-issue -- --issue TEAM-XX --intended-phase planning
# or
npm run harness:validate-issue -- --issue TEAM-XX --intended-phase implementation
```

## References

- Canonical ChatGPT prompt: [`prompts/issue-intake-chatgpt.md`](../../../prompts/issue-intake-chatgpt.md)
- Deferred GPT package: [`gpt/issue-intake/`](../../../gpt/issue-intake/)
- Template: [`templates/linear-issue.md`](../../../templates/linear-issue.md)
- Operator guide: [`docs/issue-intake.md`](../../../docs/issue-intake.md)
- Skill architecture: [`docs/skills/skill-architecture.md`](../../../docs/skills/skill-architecture.md)
- Examples: [`.agents/skills/issue-intake/examples.md`](examples.md)
