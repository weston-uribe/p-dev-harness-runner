# Milestone 7 — Issue intake

**Status:** Implemented (standalone ChatGPT issue-intake skill, template alignment, validate-issue CLI)

## What exists

- **Standalone issue-intake skill** — [`.agents/skills/issue-intake/SKILL.md`](../../.agents/skills/issue-intake/SKILL.md) is the single behavioral source. Operators copy it into a normal ChatGPT conversation for product discovery, technical investigation, scoping, and Linear issue creation. The harness does **not** execute or observe intake.
- **Parser-aligned template** — [`templates/linear-issue.md`](../../templates/linear-issue.md)
- **Operator guide** — [`docs/issue-intake.md`](../issue-intake.md)
- **Read-only validator CLI** — `harness validate-issue` with route-specific `--intended-phase planning|implementation` (validates the resulting issue contract, not intake conversation behavior)
- Reuses parser, resolver, allowlist, advisory narrow heuristic, and optional planning-marker detection
- Tests and fixtures for validation paths (issue contract / harness behavior — not intake agent reasoning)

## What is deferred / out of model

- Lead agent skill, `performance-cost-audit`, skill registry/package manager, manifests, provider/client adapters (see [`docs/skills/skill-architecture.md`](../skills/skill-architecture.md))
- Custom GPT packaging for intake (deprecated; see [`gpt/issue-intake/README.md`](../../gpt/issue-intake/README.md))
- Runtime harness integration of intake (not planned; intake remains external)
- Label enforcement in runner code
- Writing to Linear from the validator

## Prerequisites

1. `harness.config.json` with repo mappings and `allowedTargetRepos`
2. For `--issue` mode: `LINEAR_API_KEY` in `.env` (read-only fetch)

## Commands

```bash
npm install
npm test
npm run build

# Validate a draft file (planning route)
npm run harness:validate-issue -- --file draft.md --intended-phase planning

# Validate a draft file (build-direct route)
npm run harness:validate-issue -- --file draft.md --intended-phase implementation

# Validate a live Linear issue (read-only)
npm run harness:validate-issue -- --issue WES-XX --intended-phase implementation

# JSON output
npm run harness:validate-issue -- --file draft.md --json

# Regression: preflight dry-run still works
npm run harness:run -- --issue WES-FIXTURE --dry-run \
  --fixture tests/fixtures/issues/valid-target-app.md
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Passes route check (planning by default; implementation when `--intended-phase implementation`) |
| 1 | CLI/config error (bad args, missing API key, invalid phase) |
| 2 | Validation failure for the requested route |

## Pass criteria

- Created issues pass route-specific validator for the intended status
- `--intended-phase implementation` accepts broad issues when structurally valid; narrow heuristics are advisory only (uninitialized-product still blocks)
- Validator catches `ambiguous_issue`, `missing_target_repo`, `unknown_repo_denied`
- No Linear writes from validator
- Full test suite green

## Artifacts

The validator prints a report to stdout only. It does not write under `runs/`.

## Authoritative workspace

Use `/Users/weston/Code/agentic-product-development-harness` (not the stale `.cursor` workspace clone).
