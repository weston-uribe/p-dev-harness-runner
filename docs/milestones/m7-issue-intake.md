# Milestone 7 — Issue intake

**Status:** Implemented (issue-intake skill, template alignment, validate-issue CLI)

## What exists

- **Issue intake skill** — [`.agents/skills/issue-intake/SKILL.md`](../.agents/skills/issue-intake/SKILL.md) interviews Weston and produces a Linear-ready issue package
- **Parser-aligned template** — [`templates/linear-issue.md`](../templates/linear-issue.md)
- **Operator guide** — [`docs/issue-intake.md`](../issue-intake.md)
- **Read-only validator CLI** — `harness validate-issue` with route-specific `--intended-phase planning|implementation`
- Reuses parser, resolver, allowlist, narrow heuristic, and planning-marker detection
- Tests and fixtures for validation paths

## What is deferred

- Lead agent skill, `performance-cost-audit`, skill registry/package manager, manifests, provider/client adapters, and runner-skill integration (see [`docs/skills/skill-architecture.md`](../skills/skill-architecture.md))
- ChatGPT/Linear automation for intake
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

- Skill output passes route-specific validator for recommended status
- `--intended-phase implementation` fails broad issues at file-validation time
- Validator catches `ambiguous_issue`, `missing_target_repo`, `unknown_repo_denied`
- No Linear writes from validator
- Full test suite green

## Artifacts

The validator prints a report to stdout only. It does not write under `runs/`.

## Authoritative workspace

Use `/Users/weston/Code/agentic-product-development-harness` (not the stale `.cursor` workspace clone).
