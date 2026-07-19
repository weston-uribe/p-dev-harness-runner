# Milestone 3 — Implementation phase

**Status:** Implemented (live implementation path; no preview/revision/merge loop)

## What exists

- Live implementation orchestration triggered from Linear **Ready for Build**
- Optional loading of the latest durable planning comment
- Cursor SDK **cloud** implementation agent against the resolved target repo
- Linear status transitions: **Building** → **PR Open** (or **Blocked** after entering Building)
- Branch and PR capture from Cursor SDK git metadata
- Implementation summary comment posted to Linear with harness marker footer
- Extended artifacts, manifest fields, and JSONL events for implementation runs

## What is deferred

- Vercel preview capture
- PM Review transition
- Revision loop
- Watcher/poller
- Merge/deploy automation
- Releases and skills

## Prerequisites

1. Copy `.env.example` to `.env` and set:
   - `LINEAR_API_KEY`
   - `CURSOR_API_KEY`
2. Target repo must be connected in Cursor cloud settings.
3. Linear issue must include required sections and be in **Ready for Build**.

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

# Live implementation
npm run harness:run -- --issue WES-12 --phase implementation

# Auto phase infers implementation from Ready for Build
npm run harness:run -- --issue WES-12

# Retry after partial failure when issue is stuck in Building
npm run harness:run -- --issue WES-12 --phase implementation --force

# Inspect artifacts
npm run harness:inspect -- --run runs/WES-12/<run-id>
```

## Manual target-app integration gate

Do **not** use WES-11. WES-11 was the Milestone 2 planning-only gate and explicitly prohibited implementation, branches, and PRs.

Create a new Linear issue, likely **WES-12**.

**Title:** M3 implementation integration test — target app hello world

**Status:** Ready for Build

**Labels:** `harness`, `target-app`, `implementation-agent`

**Description:**

```markdown
## Target repo
owner/example-target-app

## Task
Add a temporary Hello World page to the target app and add a top-nav link to that page.

## Acceptance criteria
- [ ] A temporary Hello World page exists in the target app
- [ ] A visible top-nav link opens the Hello World page
- [ ] The change is narrow and reversible
- [ ] Validation commands are run
- [ ] A PR is opened against the target repo
- [ ] No merge is performed
- [ ] No preview capture or PM Review transition is required in this milestone

## Out of scope
- [ ] Merging the PR
- [ ] Capturing Vercel preview
- [ ] Moving the issue to PM Review
- [ ] Revision loop
- [ ] Merge/deploy automation
- [ ] Editing the harness repo except through orchestrator code
- [ ] Releases
- [ ] Skills

## Validation expectations
Run the target repo validation commands from harness config, expected to include npm run lint and npm run build if available.
```

**Pass criteria:**

- Issue moves **Ready for Build** → **Building** → **PR Open**
- PR opens against `owner/example-target-app`
- Branch matches `cursor/<issue-key>-*`
- One implementation comment includes marker footer with `branch` and `pr_url`
- `manifest.json` has `finalOutcome: success`, `branch`, `prUrl`, `cursorAgentId`, `cursorRunId`
- No merge, PM Review transition, or preview capture
- Re-run without `--force` exits with duplicate skip

## Artifacts

```text
runs/<issue>/<run-id>/
  manifest.json
  run-summary.md
  events.jsonl
  linear/
    issue-snapshot-before.json
    issue-snapshot-after.json
    planning-comment-loaded.md
    comments-written.md
  prompts/
    implementation-agent.md
  outputs/
    implementation-result.md
  cursor/
    run-result.json
  github/
    pr-metadata.json
  errors/
    error.json                 # on failure
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success or duplicate skip |
| 1 | Config / CLI error |
| 2 | Preflight or eligibility failure |
| 3 | Live phase failure after eligible start |

## Config

`harness.config.json` includes:

- `implementation.timeoutSeconds` — cloud agent wait timeout
- `implementation.branchPrefix` — deterministic branch prefix
- `repos[].validation.commands` — target-repo validation commands included in the implementation prompt

Regenerate JSON Schema after config changes:

```bash
npm run generate:config-schema
```
