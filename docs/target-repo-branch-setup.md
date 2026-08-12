# Target repo branch setup

The harness merges pull requests into an **integration branch** configured per repo (`repos[].baseBranch`, e.g. `dev`). Production promotion (`dev` → `main`) is a **manual git step** followed by an explicit harness sync.

**Release contract:** [`docs/releases/v0.3.0.md`](releases/v0.3.0.md)

## Config fields

| Field | Purpose |
|-------|---------|
| `baseBranch` | Integration branch PRs target and merge into |
| `productionBranch` | Production branch (default `main`) used for merge success routing |
| `integrationPreviewUrl` | Stable dev/staging preview link for merge comments |
| `integrationSuccessStatus` | Linear status after integration merge (default `Merged to Dev`) |
| `productionSuccessStatus` | Linear status after production merge (default `Merged / Deployed`) |

When `baseBranch === productionBranch`, behavior matches the original single-branch workflow: merge success moves the issue to **`Merged / Deployed`** and production deployment polling runs as before.

When `baseBranch !== productionBranch`, merge success moves the issue to **`Merged to Dev`**, merge comments note the change is **not yet in production**, and production deployment polling is skipped. After manually promoting `dev` → `main`, run production sync:

```bash
npm run harness:sync-production -- --repo target-app
```

For a single issue:

```bash
npm run harness:sync-production -- --issue WES-19
```

**Automatic sync:** after `main` is updated, the target repo can dispatch `production_promoted` to the harness GitHub Actions workflow (see [`docs/production-sync-automation.md`](production-sync-automation.md)). Manual CLI remains the fallback.

Harness Actions also supports **`workflow_dispatch`** with input **`sync_repo=target-app`** on **Harness Auto Runner**. Use **`sync_dry_run=true`** (default) to validate sync routing without Linear writes; set **`sync_dry_run=false`** only for live updates.

**Promotion contract:** only **merge or fast-forward** when promoting `dev` → `main`. Squash/rebase promotions that drop merge-commit ancestry are unsupported (`promotion_method_unsupported`) and will not project **Merged / Deployed**. For Vercel-backed targets, sync also requires a READY production deployment/alias containing the merge before that terminal status.

Upgrade stale target workflows with:

```bash
npm run harness:upgrade-target-workflows -- --dry-run --json
```

## Linear setup (before changing target repo `baseBranch`)

1. Add workflow status **`Merged to Dev`** on the team used by harness issues.
2. Set `linear.transitionalStatuses.mergedToDev` in `harness.config.json` if your team uses a different label.
3. Optionally set repo-level `integrationSuccessStatus` / `productionSuccessStatus` overrides.

## GitHub setup

1. Create the integration branch on the target repo (e.g. `dev` from `main`).
2. Set `repos[].baseBranch` to that branch.
3. Run `npm run harness:doctor -- --profile merge` with `GITHUB_TOKEN` set — doctor verifies each mapped repo has the configured base branch and that the token can write PR head branches for integration repair.

## Validation

- **Preflight / doctor:** `assertBaseBranchExists()` and PR head-branch write permission checks when `GITHUB_TOKEN` is available.
- **Implementation / handoff / revision / merge:** PR base must match `repos[].baseBranch` (`wrong_pr_base_branch` if not).

## Concurrent issues

Multiple issues can run planning, implementation, handoff, and revision in parallel (per-issue GitHub Actions concurrency). Merge into the same integration branch is serialized: the auto-runner gate resolves `repoConfigId` and `baseBranch`, then routes merge work to a queue group `harness-merge-{repoConfigId}-{baseBranch}` with `queue: max`. A second issue waiting to merge into integration branch runs only after the first merge completes; the runner re-inspects PR mergeability before merging.

If a queued PR becomes `behind` or `dirty` after another PR lands, the merge runner now attempts automatic integration repair while the issue remains **Merging**:

1. Deterministic GitHub update-branch merges the latest base branch into the PR branch.
2. If GitHub reports conflicts, a Composer 2.5 repair agent starts on the PR branch, fetches `origin/<baseBranch>`, runs the local base-into-head merge, resolves conflicts, commits, validates, and pushes the PR branch.
3. If validation and PR checks pass, the runner returns directly to merge without PM Review.
4. If repair fails, is ambiguous, or needs broader product judgment, the issue moves to **Blocked** with a clear reason.

Repair may edit conflict files and direct dependency-closure files required for validation. It must not push to the integration or production branch directly.

## Example (target-app)

```json
{
  "id": "target-app",
  "targetRepo": "https://github.com/owner/example-target-app",
  "baseBranch": "dev",
  "productionBranch": "main",
  "integrationPreviewUrl": "https://staging.example.com",
  "productionUrl": "https://www.example.com",
  "integrationSuccessStatus": "Merged to Dev",
  "productionSuccessStatus": "Merged / Deployed"
}
```
