# Milestone 5 — Revision phase

**Status:** Implemented (Needs Revision → Revising → PM Review; no merge loop)

## What exists

- Live revision orchestration triggered from Linear **Needs Revision**
- Reads latest durable **handoff** marker for `pr_url`, `branch`, `target_repo`, `preview_url`
- Reads latest **PM feedback** comment after the handoff marker
- Verifies linked GitHub PR is still open (`GITHUB_TOKEN` required)
- Cursor SDK **cloud** revision agent on existing branch/PR (`autoCreatePR: false`)
- Linear status transitions: **Needs Revision** → **Revising** → **PM Review** (or **Blocked** after entering Revising)
- Revision summary comment with durable marker footer keyed to `pm_feedback_comment_id`
- Post-success duplicate skip from **PM Review** when latest PM feedback already revised
- Auto phase routing: **Needs Revision** → `revision`

## What is deferred

- Engineering Review transition
- Merge/deploy automation
- Watcher/poller
- Releases and skills

## Prerequisites

1. Copy `.env.example` to `.env` and set:
   - `LINEAR_API_KEY`
   - `CURSOR_API_KEY`
   - `GITHUB_TOKEN`
2. Issue must have a prior handoff marker and PM feedback comment after handoff.
3. Issue must be in **Needs Revision** (or **Revising** with `--force` retry).

## Commands

```bash
npm install
npm test
npm run build
npm run harness:doctor

# Live revision
npm run harness:run -- --issue WES-13 --phase revision

# Auto phase infers revision from Needs Revision
npm run harness:run -- --issue WES-13

# Inspect artifacts
npm run harness:inspect -- --run runs/WES-13/<run-id>
```

## Manual integration gate

**Issue:** WES-13

**PR:** [target repo PR #4](https://github.com/owner/example-target-app/pull/4) (open, unmerged)

**Human setup:**

1. Add PM feedback comment: “Please change the Hello World page copy to say: Hello from the agentic harness.”
2. Move WES-13: **PM Review → Needs Revision**

**Live command:**

```bash
npm run harness:run -- --issue WES-13 --phase revision
```

**Pass criteria:**

- WES-13: Needs Revision → Revising → PM Review
- PR #4 updated on **same branch**; **no new PR**
- Revision comment with marker footer (`phase: revision`, `pm_feedback_comment_id`, `previous_handoff_run_id`)
- Post-success re-run from **PM Review** → duplicate skip (exit 0)

## Artifacts

```text
runs/<issue>/<run-id>/
  manifest.json
  run-summary.md
  events.jsonl
  linear/
    handoff-comment-loaded.md
    pm-feedback-comment-loaded.md
    revision-comment.md
  prompts/revision-agent.md
  outputs/revision-result.md
  github/pr-before.json
  github/pr-after.json
  vercel/deployment.json
```

## Idempotency

| Status | Matching revision marker for latest PM feedback | Result |
|--------|-----------------------------------------------|--------|
| Needs Revision | No | Proceed |
| Needs Revision | Yes | Duplicate skip |
| PM Review | Yes | Duplicate skip (post-success re-run) |
| PM Review | No | `wrong_status` |
| Other | — | `wrong_status` |
