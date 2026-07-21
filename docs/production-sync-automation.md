# Production sync automation

Operator guide for automatic production sync after a target repo integration branch is promoted to production.

**Related:** [`docs/target-repo-branch-setup.md`](target-repo-branch-setup.md), [`docs/linear-watcher-setup.md`](linear-watcher-setup.md), [`docs/operator-config.md`](operator-config.md), [`docs/releases/v0.3.0.md`](releases/v0.3.0.md)

---

## Overview

When `owner/example-target-app` **`main`** receives a push (after manual integration branch → production branch promotion), the harness should run production sync automatically:

```text
target repo push to main → repository_dispatch production_promoted → harness GHA → harness:sync-production --repo target-app
```

A scheduled reconciler also runs every 20 minutes (`harness-reconcile-production.yml` → `harness:reconcile-production`) so missed dispatches still advance deploy-verified completion.

**Promotion contract:** only **merge or fast-forward** production promotions are supported. Squash/rebase promotions that drop merge-commit ancestry are recorded as `promotion_method_unsupported` and do **not** project **Merged / Deployed**.

**Deploy gate:** when `previewProvider=vercel`, Linear **Merged / Deployed** requires a READY production deployment whose SHA contains the merge-to-dev commit, plus alias/head proof. Promotion alone records Langfuse `promoted_to_main` only.

**Target workflow upgrades:** stale dispatch targets (e.g. archived `p-dev-harness`) or invalid HTML-prefixed contract markers are a managed product upgrade via `npm run harness:upgrade-target-workflows` (contract v3 YAML `#` marker + upgrade PR). Do not hand-edit target workflows outside that path.

Powerful tokens stay in the **harness repo** GitHub Actions secrets only. The target repo receives at most **`HARNESS_DISPATCH_TOKEN`** (dispatch-only PAT scoped to the harness repo).

Manual CLI remains supported:

```bash
npm run harness:sync-production -- --repo target-app
npm run harness:reconcile-production -- --dry-run --json
npm run harness:upgrade-target-workflows -- --dry-run --json
```

---

## Workflow scope preflight

Any add or update under `.github/workflows/**` may require a git credential with GitHub **`workflow` scope**. Before pushing workflow files:

1. Run `gh auth status` and confirm scopes include `workflow`, **or**
2. Apply workflow YAML via GitHub web UI (Settings → Actions → workflow editor / “Add file”), **or**
3. Push with a PAT that includes `workflow` + `repo`.

If workflow files cannot be pushed, use the exact YAML below via GitHub UI. Do **not** leave untracked workflow files in a local clone.

---

## Harness repo: `harness-auto-runner.yml`

**Operator config:** set GitHub Actions secret **`HARNESS_CONFIG_JSON_B64`** with your private harness config so sync accepts your target repo ids. See [`docs/operator-config.md`](operator-config.md).

**Track A:** merge the updated workflow to [`.github/workflows/harness-auto-runner.yml`](../.github/workflows/harness-auto-runner.yml) using a credential with **`workflow` scope**.

**Track B (OAuth lacks `workflow` scope):** copy the full intended workflow from [`tests/fixtures/workflows/harness-auto-runner-with-production-sync.yml`](../tests/fixtures/workflows/harness-auto-runner-with-production-sync.yml) into GitHub web UI → edit `harness-auto-runner.yml` on `main`. Automation is **not live** until this lands on origin.

The harness workflow must include:

- `repository_dispatch` type **`production_promoted`**
- Job **`sync-production`** running `npm run harness:sync-production -- --repo … --json`
- Optional **`workflow_dispatch`** input **`sync_repo`** (e.g. `target-app`) for manual cloud sync
- Optional **`workflow_dispatch`** input **`sync_dry_run`** (default **`true`**) — passes `--dry-run` to `harness:sync-production` so manual cloud validation inspects Linear without writes

### Manual cloud sync (harness Actions)

Actions → **Harness Auto Runner** → Run workflow → set **`sync_repo`** = `target-app` (leave **`issue`** empty).

**Safe cloud validation sequence** (after `HARNESS_CONFIG_JSON_B64` is set):

1. **`sync_repo=harness`** (or any repo where `baseBranch === productionBranch`) — confirms config loading and repo resolution with a no-op exit when branches match.
2. **`sync_repo=real-target`** with **`sync_dry_run=true`** (default) — inspects production-sync routing and Linear issue candidates **without writes**.
3. **`sync_dry_run=false`** only when ready for actual Linear status updates after a real `dev` → `main` promotion.

Example dry-run dispatch:

```bash
gh workflow run "Harness Auto Runner" \
  --repo weston-uribe/agentic-product-development-harness \
  -f sync_repo=real-target \
  -f sync_dry_run=true
```

`production_promoted` **repository_dispatch** runs always use live sync (no dry-run).

---

## Event payload

**Event type:** `production_promoted`

```json
{
  "repo": "target-app",
  "productionBranch": "main",
  "sourceRepo": "owner/example-target-app",
  "after": "<commit-sha-on-main>",
  "ref": "refs/heads/main",
  "receivedAt": "2026-07-07T23:46:00.000Z"
}
```

Optional: `githubRunId`, `githubDeliveryId` (audit only). Harness ignores `after` for promotion proof; per-issue strong proof is unchanged.

### Test dispatch (no target repo push)

Requires harness workflow on origin with `production_promoted` handler (see Track B fixture). Use JSON body:

```bash
gh api repos/weston-uribe/agentic-product-development-harness/dispatches --method POST --input - <<'EOF'
{
  "event_type": "production_promoted",
  "client_payload": {
    "repo": "target-app",
    "productionBranch": "main",
    "sourceRepo": "owner/example-target-app",
    "after": "<main-sha>",
    "ref": "refs/heads/main",
    "receivedAt": "2026-07-07T23:46:00.000Z"
  }
}
EOF
```

Requires a PAT with **Contents: write** on the harness repo (same class as Vercel `GITHUB_DISPATCH_TOKEN`).

---

## Target repo: trigger workflow

**GUI path (Milestone 5):** after local config is ready, use Settings / Configure → **Remote setup** → target repo card to preview and open an install PR on branch `harness/setup-production-sync-<repoConfigId>`. The GUI never writes directly to the production branch. See [`docs/gui-remote-setup.md`](gui-remote-setup.md).

**Track A:** add the file below to **`owner/example-target-app`** using a **`workflow`-scoped** credential.

**Track B:** copy from [`tests/fixtures/workflows/trigger-harness-production-sync.yml`](../tests/fixtures/workflows/trigger-harness-production-sync.yml) via GitHub web UI → **Add file** on production branch.

Path: `.github/workflows/trigger-harness-production-sync.yml`

```yaml
# See tests/fixtures/workflows/trigger-harness-production-sync.yml for canonical content.
```

**Guards:** runs only on **`main`** pushes — not the integration branch, not issue branches.

### Target repo secret

In the **target repo** → Settings → Secrets and variables → Actions:

| Secret | Permission |
|--------|------------|
| `HARNESS_DISPATCH_TOKEN` | Fine-grained **Contents: Read and write** on `weston-uribe/agentic-product-development-harness` only; or classic `repo` scoped to harness repo |

Can reuse the same PAT as Vercel `GITHUB_DISPATCH_TOKEN` for the Linear bridge.

**Do not** add `LINEAR_API_KEY` or merge-capable target-repo `GITHUB_TOKEN` to the target repo.

---

## Track B: webhook trigger (optional)

If adding a target repo workflow file is blocked, configure a **GitHub repo webhook** on the target repo (Settings → Webhooks):

- URL: future harness Vercel endpoint (not implemented in v1; prefer target repo workflow above)
- Events: **Push**
- Filter in handler: `ref == refs/heads/main` only

The harness workflow change on `production_promoted` is **still required**; webhook only replaces the target repo workflow file.

---

## Validation gates

1. `npm test`, `npm run test:webhook`, `npm run build`, `npm run harness:doctor`
2. Set `HARNESS_CONFIG_JSON_B64` with private config including target repo id (see [`docs/operator-config.md`](operator-config.md))
3. Dispatch test (`gh api … production_promoted`) → harness **sync-production** job runs (not `run-harness`)
3. Target repo push to **`main`** → dispatch → sync job
4. Target repo push to integration branch → no dispatch workflow run
5. Repeat **`main`** push → idempotent (no duplicate Linear comments)
6. Issues update to **Merged / Deployed** only when merge commit is reachable on `main` **and** (for Vercel targets) a READY production deployment/alias proves the merge is live

---

## Rollback

1. Disable or delete target repo `trigger-harness-production-sync.yml`
2. Remove `production_promoted` handler from harness workflow (or disable workflow)
3. Continue manual sync: `npm run harness:sync-production -- --repo target-app`
