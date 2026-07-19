# Provider portability and configuration posture

This document describes what is configurable, what is fixed, and what is
intentionally **not** claimed for the harness. Read this as a promise boundary: what v0.3.0 supports today, and what it deliberately does not claim. It complements
[`docs/decisions/0004-agent-provider-boundary.md`](decisions/0004-agent-provider-boundary.md).

**Release contract:** [`docs/releases/v0.3.0.md`](releases/v0.3.0.md)

## Current v0.3.0 posture

v0.3.0 is a **Cursor-first** harness for **Linear + GitHub + GitHub Actions**. The
architecture is modular by subsystem (product system, SCM/PR system, runner,
agent provider, preview provider), but it is **not provider-agnostic yet**.
Cursor is the only implemented agent execution provider. Runner phases import
[`src/agents/`](../src/agents/) (provider-facing facade); the Cursor adapter
delegates to [`src/cursor/`](../src/cursor/) for SDK-specific behavior.

### Support matrix

| Subsystem | Implemented / supported in v0.3.0 |
|-----------|----------------------------------|
| Product system | Linear |
| Source control / PR system | GitHub |
| Runner | GitHub Actions |
| Agent provider | Cursor Cloud Agents only |
| Model policy | standard / basic Composer 2.5 unless deliberately changed |
| Preview provider | Vercel or none |
| Target repos | GitHub repos configured in `harness.config.json` |

## What is configurable today

The following are configurable through `harness.config.json` (see
[`harness.config.schema.json`](../harness.config.schema.json)):

- `repos[].id`
- `repos[].linearProjects`
- `repos[].linearTeams`
- `repos[].targetRepo`
- `repos[].baseBranch`
- `repos[].productionBranch`
- `repos[].previewProvider`
- `repos[].integrationPreviewUrl`
- `repos[].productionUrl`
- `repos[].integrationSuccessStatus`
- `repos[].productionSuccessStatus`
- `repos[].validation.commands`
- `allowedTargetRepos`
- `linear.eligibleStatuses`
- `linear.transitionalStatuses`
- timeouts and check/preview polling behavior
- `agentProvider.id` — currently only `"cursor"` is accepted
- `agentProvider.model.id` — preferred source for model resolution
- `defaultModel.id` — backward-compatible fallback when `agentProvider.model` is absent

## What is fixed in v0.3.0

The following are structural assumptions in v0.3.0 and are **not** configurable as
provider swaps:

- Linear as the product system
- GitHub as the SCM / PR provider
- GitHub Actions as the cloud runner
- Cursor Cloud Agents as the agent provider
- Cursor-specific run observation
- Cursor-specific marker fields
- Vercel-specific preview capture where preview is enabled

## What is intentionally not claimed

To avoid overstating maturity, the harness does **not** claim any of the
following in v0.3.0:

- Claude Code support
- Codex support
- local VS Code agent support
- GitLab / Bitbucket support
- generic PM-system support
- production-grade portability
- production SaaS maturity
- provider-agnostic operation

## Future provider adapter requirements

A future agent provider adapter should support the full run lifecycle used by
the runner phases today:

- planning run creation
- implementation run creation
- revision run against an existing PR branch
- integration repair run against an existing PR branch
- lifecycle observation
- terminal status capture
- assistant output capture
- branch/PR capture
- provider diagnostics
- timeout/cancellation
- generic error mapping
- validation evidence reporting
- raw provider artifact retention

## Skill portability

Harness skills are portable workflow contracts stored canonically at
[`.agents/skills/<skill-name>/SKILL.md`](../.agents/skills/). Client-specific
locations (`.cursor/skills`, `.claude/skills`, ChatGPT project files, future
Codex adapters) are export or adaptation targets — not canonical sources.

Implemented canonical skills: `issue-intake`, `code-health-audit`,
`architecture-evolution-audit`, `security-audit`, `planner`, and `implementation`
at [`.agents/skills/<skill-name>/SKILL.md`](../.agents/skills/). `performance-cost-audit`,
skill registry, package manager, skill manifests, runner-skill prompt integration,
and provider/client adapters are **not implemented** — see
[`docs/skills/skill-architecture.md`](skills/skill-architecture.md).
SDK runner prompts in [`src/prompts/`](../src/prompts/) remain runner
implementation details, not canonical skills.

## Recommended next implementation steps

1. **Make Cursor explicit** in docs and config posture rather than implying
   provider agnosticism. *(Done: `agentProvider.id: "cursor"` config shape and
   `src/agents/` provider seam; only Cursor is implemented.)*
2. **Introduce an internal provider seam** that isolates Cursor SDK calls out of
   the runner phases behind a single interface. *(Done: runner phases import
   `src/agents/`; Cursor implementation remains in `src/cursor/`.)*
3. **Extend provider config only when a second adapter exists** — the
   `agentProvider` shape is Cursor-only today; do not add speculative provider
   ids or a plugin system.
4. **Preserve legacy markers** (`cursorAgentId`, `cursorRunId`) and Linear
   metadata until they can be safely migrated behind the provider seam.
5. **Validate a second adapter** end-to-end against the full lifecycle before
   claiming any additional provider support.
