# Milestone 2 — Planning phase

**Status:** Implemented (live planning path; no implementation agent)

## What exists

- Live planning orchestration triggered from Linear **Ready for Planning**
- Cursor SDK **cloud** planning agent against the resolved target repo (not harness cwd)
- Linear status transitions: **Planning** → **Ready for Build** (or **Blocked** on failure after entering Planning)
- Planning comment posted to Linear with harness marker footer
- Idempotency guard via marker footer (`harness-orchestrator-v1`, `phase: planning`, `run_id`, cursor IDs, model, target repo)
- Extended artifacts, manifest fields, and JSONL events for planning runs
- Doctor checks `CURSOR_API_KEY` (required for live planning); model/repo listing is warn-only

## What is deferred

- Implementation / build phase agent
- Branch creation, PR open, preview capture, watcher poller
- Revision and merge/deploy loops

## Prerequisites

1. Copy `.env.example` to `.env` and set:
   - `LINEAR_API_KEY`
   - `CURSOR_API_KEY`
2. Target repo must be connected in Cursor cloud settings (validated by live planning run; doctor warns if `Cursor.repositories.list()` is unavailable).
3. Linear issue must include required sections (see Milestone 1 docs) and be in **Ready for Planning**.

## Commands

```bash
npm install
npm test
npm run build

# Config and auth checks
npm run harness:doctor

# M1 regression (fixture, no network)
npm run harness:run -- --issue WES-FIXTURE --dry-run \
  --fixture tests/fixtures/issues/valid-target-app.md

# Optional live preflight (read-only)
npm run harness:run -- --issue WES-XX --dry-run

# Live planning (manual integration gate)
npm run harness:run -- --issue WES-XX --phase planning

# Auto phase infers planning from issue status
npm run harness:run -- --issue WES-XX

# Re-run after partial failure (issue stuck in Planning)
npm run harness:run -- --issue WES-XX --phase planning --force

# Inspect artifacts
npm run harness:inspect -- --run runs/WES-XX/<run-id>
```

## Manual target-app integration test

Create a Linear issue in **Ready for Planning** targeting the target repo.

**Suggested task (planning-only, harmless):**

> Plan adding a temporary Hello World page and top-nav link. Do not implement.

**Required sections:** Target repo, Task, Acceptance criteria, Out of scope

**Run:**

```bash
npm run harness:run -- --issue WES-XX --phase planning
```

**Pass criteria:**

- Linear issue moves to **Ready for Build**
- One planning comment with full marker footer
- `runs/WES-XX/<run-id>/manifest.json` has `cursorAgentId`, `cursorRunId`, `finalOutcome: success`
- No PR or branch on the target repo
- Re-run without `--force` exits with duplicate skip and does not post a new comment

## Artifacts (planning run)

```text
runs/<issue>/<run-id>/
  manifest.json
  run-summary.md
  events.jsonl
  linear/
    issue-snapshot-before.json
    issue-snapshot-after.json
    comments-written.md
  prompts/
    planning-agent.md
  outputs/
    planning-result.md
  cursor/
    run-result.json
  errors/
    error.json                 # on failure
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success or duplicate skip |
| 1 | Config / CLI error |
| 2 | Preflight failure (parse, resolver, allowlist) |
| 3 | Planning phase failure after eligible start |

## Authoritative workspace

Use `/Users/weston/Code/agentic-product-development-harness` (not the stale `.cursor` workspace clone).

## Config

`harness.config.json` adds:

- `defaultModel` — Cursor model for planning agent
- `linear.transitionalStatuses.readyForBuild` — post-planning status
- `planning.timeoutSeconds` — cloud agent wait timeout (default 1800)

Regenerate JSON Schema (optional):

```bash
npm run generate:config-schema
```
