# Milestone 6 — Merge phase

**Status:** Implemented (Ready to Merge → Merging → Merged / Deployed)

## What exists

- Live merge orchestration triggered from Linear **Ready to Merge**
- Reads latest **revision** marker if present; otherwise latest **handoff** marker
- Verifies GitHub PR is open, correct repo, and checks policy before merge
- Squash merges PR via GitHub REST API (`GITHUB_TOKEN` with merge permission required)
- Best-effort production deployment URL capture after merge
- Posts merge completion comment with durable marker footer
- Linear transitions: **Ready to Merge** → **Merging** → **Merged / Deployed**
- Recovery path when PR already merged without merge marker
- Integration repair after merge-queue drift: deterministic GitHub update-branch first, then a narrow Composer 2.5 Cursor repair agent if conflicts require local resolution
- Post-success duplicate skip from **Merged / Deployed**
- Auto phase routing: **Ready to Merge** → `merge`

## What is deferred

- Engineering Review
- Release tags / GitHub Releases
- Branch deletion (config flag `deleteBranchAfterMerge` defaults **false**)
- Watcher/poller
- Skills
- Vercel API token integration

## Prerequisites

1. Copy `.env.example` to `.env` and set:
   - `LINEAR_API_KEY`
   - **`GITHUB_TOKEN`** with `repo` merge permissions and PR head-branch write (classic `repo`, or fine-grained Contents: Read and write plus Pull requests: Read and write)
   - `CURSOR_API_KEY` when integration repair may need an agent
2. Issue must have a prior handoff or revision marker with `pr_url`.
3. PM must manually move issue **PM Review → Ready to Merge** before running merge.
4. Run `npm run harness:doctor -- --profile merge`; doctor verifies base branches and target-repo write permission needed for PR branch repair.

## Commands

```bash
npm install
npm test
npm run build
npm run harness:doctor

# Live merge
npm run harness:run -- --issue WES-13 --phase merge

# Auto phase infers merge from Ready to Merge
npm run harness:run -- --issue WES-13

# Inspect artifacts
npm run harness:inspect -- --run runs/WES-13/<run-id>
```

## Manual integration gate

**Issue:** WES-13

**PR:** [target repo PR #4](https://github.com/owner/example-target-app/pull/4)

**Human setup:**

1. Review PR #4 / preview manually.
2. Move WES-13: **PM Review → Ready to Merge**

**Live command:**

```bash
npm run harness:run -- --issue WES-13 --phase merge
```

**Pass criteria:**

- WES-13: Ready to Merge → Merging → **Merged / Deployed**
- PR #4 **squash merged** on GitHub
- Completion comment with `phase: merge` marker footer
- Deployment URL captured if available; warning only if not (default config)
- Re-run from **Merged / Deployed** → duplicate skip (exit 0)

## Checks policy (default)

| Check state | Behavior |
|-------------|----------|
| success | Allow merge |
| neutral / skipped | Allow merge |
| failure / cancelled / action_required | Block (`checks_failing`) |
| pending | Block (`checks_pending`) |
| none / unreadable | Block (`checks_unknown`) |

Override via `merge.allowPendingChecks` / `merge.allowUnknownChecks` in config.

**Vercel preview note:** When GitHub check runs and commit statuses are inconclusive but the Vercel bot comment reports **Ready**, merge proceeds with a warning (see `validationSummary` in manifest).

## Integration repair

When a PR becomes `behind` or `dirty` after waiting in the serialized merge queue:

1. The issue stays **Merging**.
2. The runner verifies `GITHUB_TOKEN` can write PR head branches.
3. The runner calls GitHub update-branch, which merges the latest base branch into the PR branch.
4. If update-branch succeeds cleanly, the runner waits for checks and returns directly to merge.
5. If update-branch cannot resolve conflicts, the runner launches a Composer 2.5 Cursor cloud repair agent on the PR branch.
6. The repair agent fetches the base branch, locally merges base into head, resolves conflicts, commits, runs validation, and pushes the PR branch.
7. The runner re-inspects the PR, waits for checks, and returns directly to merge if validation passes.
8. If repair fails, is ambiguous, violates scope, or needs broader product judgment, the issue moves to **Blocked** with an actionable reason.

Repair may edit conflict files and direct dependency-closure files required to compile and pass validation. It may not make unrelated product changes, broad refactors, broad formatting sweeps, or direct edits to `dev` / `main`.

Canceled repair runs recover through **Harness Auto Runner** `workflow_dispatch` with the issue key, `phase=merge`, and force enabled. There is no Merging webhook re-dispatch in v1.

## Artifacts

```text
runs/<issue>/<run-id>/
  manifest.json
  run-summary.md
  events.jsonl
  linear/
    merge-source-comment-loaded.md
    merge-completion-comment.md
  github/
    pr-before-merge.json
    checks-before-merge.json
    merge-result.json
    pr-after-merge.json
  prompts/
    integration-repair-agent.md # only when agent repair runs
  vercel/
    production-deployment.json
  outputs/
    merge-recovery.json   # only on post-merge Linear failure
```

## Idempotency

| Scenario | Result |
|----------|--------|
| Ready to Merge, PR open, no merge marker | Proceed |
| Merge marker exists for PR URL | Duplicate skip |
| Merged / Deployed | Duplicate skip |
| PR merged, no merge marker | Recovery: post comment + move to Merged / Deployed |
| PM Review (no Ready to Merge) | `wrong_status` |
