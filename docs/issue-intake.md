# Issue intake

Issue intake is an **external, operator-invoked ChatGPT workflow**. It is not part of the harness runtime.

A human copies the canonical skill into a normal ChatGPT conversation. That conversation investigates the request, scopes PR-sized work, and creates Linear issues. The harness begins only after those issues exist and a human moves each issue from **Backlog** to **Ready for Planning** or **Ready for Build**.

```text
Standalone ChatGPT intake agent
  → creates complete Linear issue(s) (default status: Backlog)
  → human moves each issue to Ready for Planning or Ready for Build
  → existing harness processes the issue using its Linear contract
```

The harness does **not** execute, test, or observe the intake conversation.

## Canonical skill

Copy the **entire** file into a new ChatGPT conversation:

[`.agents/skills/issue-intake/SKILL.md`](../.agents/skills/issue-intake/SKILL.md)

That file is the single behavioral source of truth. It is fully standalone when pasted alone. Illustrative examples (non-authoritative) live at [`.agents/skills/issue-intake/examples.md`](../.agents/skills/issue-intake/examples.md).

Compatibility pointers (no independent behavioral contract):

- [`prompts/issue-intake-chatgpt.md`](../prompts/issue-intake-chatgpt.md)
- [`gpt/issue-intake/README.md`](../gpt/issue-intake/README.md) (Custom GPT path deprecated)
- [`skills/issue-intake/README.md`](../skills/issue-intake/README.md)

## Operating model (summary)

- Investigate with connected tools before asking discoverable factual questions.
- Default to review-first issue creation; auto-create only when explicitly preauthorized.
- Default new issues to **Backlog** unless the user explicitly chooses another status.
- Planning is optional; the user selects planning or build-direct via Linear status later.
- One Linear issue → exactly one target repository → one coherent PR-sized outcome.
- No parent/child coordination issues; no research-spike / exploratory Linear issues.
- Preserve the uninitialized-product foundation guard: do not place uninitialized feature work in Ready for Build.

## After issues exist: validate-issue CLI

`harness:validate-issue` validates the **resulting Linear issue contract** (parser sections, target repo, structural readiness). It does **not** evaluate how the ChatGPT intake agent reasoned or asked questions.

```bash
# Structural check for planning-oriented readiness
npm run harness:validate-issue -- --file draft.md --intended-phase planning

# Structural check for Ready for Build eligibility (narrow heuristics are advisory only)
npm run harness:validate-issue -- --file draft.md --intended-phase implementation

# General check (both routes reported; exit 0 if planning-valid)
npm run harness:validate-issue -- --file draft.md

# Live Linear issue (read-only)
npm run harness:validate-issue -- --issue TEAM-XX --intended-phase implementation
```

## Plan-first vs build-direct

| Route | Linear status | Who chooses |
|-------|---------------|-------------|
| Plan first | Ready for Planning | Human, after intake creates the issue (usually from Backlog) |
| Build direct | Ready for Build | Human; status-authoritative — no planning comment required |
| Default after intake | Backlog | Intake default unless user explicitly approved another status |

**Routing is the Linear status field.** Labels (`requires-plan`, `skip-plan`) are operational hints only — the runner does not enforce them.

Historical narrow-size thresholds (task length, acceptance-criteria count) are **advisory only**. They do not fail `--intended-phase implementation` and do not block the runner. Uninitialized-product foundation still blocks Ready for Build until foundation planning completes.

## File vs Linear validation

| Mode | Planning marker |
|------|-----------------|
| `--file` | Not required for Ready for Build eligibility |
| `--issue` | Optional — a durable planning comment is supplemental context if present |

If the operator selects **Ready for Build**, validate structural readiness (`--intended-phase implementation`); do not treat missing planning markers as a hard failure.

## Parser contract

Authoritative parser: [`src/linear/parser.ts`](../src/linear/parser.ts)

Template: [`templates/linear-issue.md`](../templates/linear-issue.md)

Assign the issue to a Linear project mapped in [`harness.config.json`](../harness.config.json) `repos[].linearProjects`. The runner resolves target repo from project when `## Target repo` is absent.

| Linear project (WES) | Resolved target repo |
|----------------------|----------------------|
| Example Target App | `owner/example-target-app` |
| Agentic Product Development Harness | `weston-uribe/agentic-product-development-harness` |

Project descriptions may include:

```text
Harness metadata:
Target repo: owner/repo
Product initialization: uninitialized
```

For PDev-created products, Linear project metadata is written during workspace setup and updated to `initialized` after the approved foundation PR merges to the development branch.

Intake reads `Harness metadata:` (and related workspace evidence) itself. Do not assume application deployment is configured from `.p-dev/product.json`. Runtime preview/deployment capability comes from harness `repos[].previewProvider` only.

Required description sections (intake authoring contract):

- `## Target repo` (include when known — derived from project metadata or override)
- `## Task`
- `## Acceptance criteria` (≥1 `-` bullet; product outcomes)
- `## Out of scope` (≥1 `-` bullet)
- `## Validation expectations` — required for new intake packages; structure as Automated checks, Behavioral acceptance verification (or `Planner must determine the representative runtime verification method.`), Regression checks, and Required evidence

The Linear description parser still treats `## Validation expectations` as optional for legacy issues. New intake must always include structured proof expectations. Intake defines what proof will be required later; it does not claim tests already passed.

## Related

- Canonical skill: [`.agents/skills/issue-intake/SKILL.md`](../.agents/skills/issue-intake/SKILL.md)
- Compatibility pointers: [`prompts/issue-intake-chatgpt.md`](../prompts/issue-intake-chatgpt.md), [`gpt/issue-intake/README.md`](../gpt/issue-intake/README.md)
- Milestone doc: [`docs/milestones/m7-issue-intake.md`](milestones/m7-issue-intake.md)
- State machine: [`docs/architecture/linear-automation-state-machine.md`](architecture/linear-automation-state-machine.md)
