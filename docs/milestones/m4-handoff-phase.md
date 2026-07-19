# Milestone 4 — Handoff phase

**Status:** Implemented (PR Open → PM Review handoff; no revision loop or merge)

## What exists

- Live handoff orchestration triggered from Linear **PR Open**
- Reads the latest durable **implementation** marker comment for `pr_url`, `branch`, and `target_repo`
- Inspects the linked GitHub PR via REST API (`GITHUB_TOKEN` required)
- Captures Vercel preview URL from PR comments when available (bounded polling)
- Posts PM handoff comment to Linear with harness marker footer
- Linear status transition: **PR Open** → **PM Review** (or **Blocked** after handoff begins on failure)
- Extended artifacts, manifest fields, and JSONL events for handoff runs
- Auto phase routing: **PR Open** → `handoff` (not implementation)

## What is deferred

- Revision loop (**Needs Revision** → **Revising** → **PM Review**)
- Engineering Review transition
- Merge/deploy automation
- Watcher/poller
- Releases and skills

## Prerequisites

1. Copy `.env.example` to `.env` and set:
   - `LINEAR_API_KEY`
   - **`GITHUB_TOKEN`** (required for handoff — `repo` or fine-grained PR read scope)
2. Issue must be in **PR Open** with a prior implementation marker comment containing `pr_url`.
3. `CURSOR_API_KEY` is **not** required for handoff runs.

## Commands

```bash
npm install
npm test
npm run build

# Config and auth checks (GITHUB_TOKEN required under M4)
npm run harness:doctor

# Live handoff
npm run harness:run -- --issue WES-13 --phase handoff

# Auto phase infers handoff from PR Open
npm run harness:run -- --issue WES-13

# Inspect artifacts
npm run harness:inspect -- --run runs/WES-13/<run-id>
```

## Manual integration gate

**Issue:** WES-13 (starts **PR Open**)

**PR:** [target repo PR #4](https://github.com/owner/example-target-app/pull/4) (open, unmerged)

**Pass criteria:**

- WES-13: PR Open → PM Review
- Exactly one new handoff comment with marker footer (`phase: handoff`, `pr_url`, `branch`, `preview_url` if found, `previous_implementation_run_id`)
- `manifest.json`: `finalOutcome: success`, populated `prUrl`, `branch`, `changedFiles`, `checkSummary`
- Artifacts: `github/pr.json`, `linear/handoff-comment.md`, `vercel/deployment.json` (if preview captured)
- PR #4 remains **open**, **unmerged**
- Re-run without `--force` → duplicate skip (exit 0)

**Do not:** merge PR #4, rerun WES-12, modify target repo manually, move to Engineering Review.

## Artifacts

```text
runs/<issue>/<run-id>/
  manifest.json
  run-summary.md
  events.jsonl
  linear/
    issue-snapshot-before.json
    issue-snapshot-after.json
    implementation-comment-loaded.md
    handoff-comment.md
    comments-written.md
  github/
    pr.json
    checks.json
  vercel/
    deployment.json
  errors/
    error.json                 # on failure
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success or duplicate skip |
| 1 | Config / CLI error |
| 2 | Preflight, eligibility, or auth failure (no Linear writes when auth fails at start) |
| 3 | Live phase failure after handoff began |

## Config

`harness.config.json` includes:

- `handoff.allowPmReviewWithoutPreview` — proceed to PM Review when preview is not found (default: `true`)
- `preview.pollTimeoutSeconds` — max wait for Vercel preview comment
- `preview.pollIntervalSeconds` — poll interval between comment fetches
- `linear.eligibleStatuses.handoff` — statuses eligible for handoff (default: PR Open)

Regenerate JSON Schema after config changes:

```bash
npm run generate:config-schema
```

## GITHUB_TOKEN

Handoff requires a valid GitHub token before any Linear writes:

- `harness:doctor` fails when `GITHUB_TOKEN` is missing or invalid
- Handoff preflight returns exit code 2 with `github_auth_failure` when the token is absent at run start

Recommended scopes: classic `repo` or fine-grained token with read access to pull requests and checks for the target repository.
