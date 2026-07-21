# Operator configuration

Guide for private target-repo configuration so production sync and harness automation work for operator-specific repos without committing personal wiring to the public harness repo.

**Related:** [`docs/getting-started.md`](getting-started.md), [`docs/production-sync-automation.md`](production-sync-automation.md), [`docs/security.md`](security.md)

---

## Overview

The committed [`harness.config.json`](../harness.config.json) is a **generic example** (`target-app`, `owner/example-target-app`). Real operator target repos belong in **private configuration** loaded at runtime.

Config resolution order (fail closed):

1. **Explicit CLI `--config`** — only when `argv` contains `--config` (overrides ambient env)
2. **`HARNESS_CONFIG_JSON_B64`** — base64-encoded JSON (GitHub Actions secret)
3. **`HARNESS_CONFIG_JSON`** — raw JSON string (local/debug)
4. **`HARNESS_CONFIG_PATH`** — path to a local config file
5. **`harness.config.json`** — committed default example

If the resolved source is missing, unreadable, or invalid, harness commands exit non-zero.

---

## Recommended local setup

**GUI path (recommended):**

1. `npm run harness:gui` — guided Settings / Configure forms with preview and confirmation-gated local writes
2. Apply `.env.local` and `.harness/config.local.json` from the GUI, or use CLI scaffold below as fallback
3. `npm run harness:doctor`

**CLI scaffold path:**

1. `npm run harness:operator:init` — scaffolds `.env.local` and `.harness/config.local.json` from committed examples via setup core services (does not overwrite unless `--force`)
2. Edit `.harness/config.local.json` with your real target repo mapping
3. Keep `HARNESS_CONFIG_PATH=.harness/config.local.json` in `.env.local`
4. `npm run harness:doctor`

| File | Role |
|------|------|
| `.env.local` | Local secrets and `HARNESS_CONFIG_PATH` pointer (gitignored) |
| `.harness/config.local.json` | Structured private target-repo config (gitignored) |
| [`.harness/config.example.json`](../.harness/config.example.json) | Committed starter template (single target repo) |
| [`harness.config.json`](../harness.config.json) | Committed public example/fallback when no private source is set |

The starter config in `.harness/config.example.json` is for first-time users with **one** target repo. Add more entries to `repos[]` and `allowedTargetRepos[]` for every repo you want the harness to manage.

Setup core services in [`src/setup/`](../src/setup/) power `harness:operator:init`, the local Product Development Harness GUI Settings / Configure screen (`npm run harness:gui`), confirmation-gated local file writes (`src/setup/local-apply-actions.ts`), and confirmation-gated remote harness secret / target workflow PR writes (`src/setup/remote-apply-actions.ts`). They support dry-run previews, local and remote writes after confirmation, permission classification, and manual instruction generation without changing runtime harness automation behavior.

**Remote setup (GUI):** after local config is in place, use Settings / Configure → **Remote setup** to preview and apply harness repo Actions secrets and target workflow install PRs. See [`docs/gui-remote-setup.md`](../gui-remote-setup.md).

GUI-assisted fields:

| Surface | Fields |
|---------|--------|
| `.env.local` | `HARNESS_CONFIG_PATH`, `LINEAR_API_KEY`, `CURSOR_API_KEY`, `GITHUB_TOKEN` |
| `.harness/config.local.json` | `linear.teamKey`, `linear.teamId`, model id, per-repo `id`, `targetRepo`, branches, `previewProvider` (`vercel` or `none`), preview URLs, Linear status names, validation commands |

Local GUI docs: [`docs/gui-local.md`](../gui-local.md)

---

## Private config is a full replacement (not an overlay)

**`HARNESS_CONFIG_JSON_B64` and other private config sources replace the whole harness config for that run.** They do **not** merge with or overlay committed [`harness.config.json`](../harness.config.json).

When a private source wins the resolution chain, only that JSON is used. Any repo id the harness must resolve in cloud automation must appear in the private config itself, with matching entries in both `repos[]` and `allowedTargetRepos[]`.

**Example:** If an operator sets `HARNESS_CONFIG_JSON_B64` with only one private target repo, harness self-automation may stop resolving the `harness` repo id from the committed fallback. For an operator managing multiple repos (e.g. `my-app` and the harness repo itself), the private config must include **every** repo the harness should manage — not just the newest target.

Do not solve this by committing operator-specific values to the public repo. Document and maintain the full private JSON locally and in `HARNESS_CONFIG_JSON_B64`.

---

## Local development

Point at a private config file:

```bash
export HARNESS_CONFIG_PATH=/path/to/private/harness.config.json
npm run harness:doctor
```

Or pass an explicit file (overrides env):

```bash
npm run harness:doctor -- --config /path/to/private/harness.config.json
```

Inline JSON for quick tests:

```bash
export HARNESS_CONFIG_JSON='{"version":1,...}'
npm run harness:doctor
```

---

## GitHub Actions (private operator config)

1. Maintain a **private** config locally at `.harness/config.local.json` (via `npm run harness:operator:init`) — do not commit operator target repos to the public harness repo.
2. Ensure the private JSON includes **every** repo the harness should manage in `repos[]` and `allowedTargetRepos[]` (full replacement — see above).
3. Base64-encode the full config (no newlines):

   ```bash
   base64 < .harness/config.local.json | tr -d '\n'
   ```

4. Store the result as GitHub Actions secret **`HARNESS_CONFIG_JSON_B64`** on the harness repo.
5. The secret must include all operator `repos[]` entries, Linear mappings, and `allowedTargetRepos` — it replaces committed `harness.config.json` for cloud runs.

The harness workflow sets `HARNESS_CONFIG_JSON_B64` on all jobs (`gate`, `run-harness`, `run-merge`, `sync-production`). Because GHA does not pass `--config`, the secret is used automatically.

---

## Migrating from public target-app config

The committed [`harness.config.json`](../harness.config.json) demonstrates shape only — it is **not** an operator’s live target-repo wiring.

To run production sync for a real target repo:

1. Copy the example config to a **private file** and add your target repo under `repos[]` with a stable `id` (e.g. `real-target`).
2. Add the target URL to `allowedTargetRepos`.
3. Set **`HARNESS_CONFIG_JSON_B64`** in harness repo Actions secrets with the full private JSON.
4. Update the **target repo dispatch workflow** ([`tests/fixtures/workflows/trigger-harness-production-sync.yml`](../tests/fixtures/workflows/trigger-harness-production-sync.yml)) so the `production_promoted` payload `repo` field matches your private config `repos[].id` (not necessarily `target-app`).
5. Until private config is present, production sync **fails closed** with `unknown_repo_id` when dispatch references a repo id not in the resolved config.

See [`docs/production-sync-automation.md`](production-sync-automation.md) for dispatch payload shape and trigger workflow setup.

---

## Target repo dispatch workflow

Install in each target repo (not in the harness repo):

- Path: `.github/workflows/trigger-harness-production-sync.yml`
- Canonical fixture: [`tests/fixtures/workflows/trigger-harness-production-sync.yml`](../tests/fixtures/workflows/trigger-harness-production-sync.yml)

Operator replaces:

- Harness dispatch URL (owner/repo of harness installation)
- Payload `repo` → private config `repos[].id`
- Payload `sourceRepo` → `owner/target-repo` slug matching configured `targetRepo`

**Guards:** runs only on production branch pushes (e.g. `main`), not integration branch pushes.

---

## Application preview provider (`previewProvider`)

Each `repos[]` entry may set `previewProvider`:

| Value | Meaning |
|-------|---------|
| `"vercel"` | Harness polls target-repo PR comments and production merge output for Vercel application preview/deployment URLs. |
| `"none"` | Skip application preview capture. Handoff, implementation, revision, and merge phases log `application_preview_not_configured` and continue without polling. |

`previewProvider: "none"` does **not** disable the **PDev automation bridge** (Linear webhook → harness dispatch). That bridge is configured separately in guided setup Step 3 and still requires `VERCEL_TOKEN` when used.

Use `"none"` when the target app is not deployed on Vercel or when PM review should proceed without automated preview URLs.

---

## Branch protection

Target repos should use integration branch + production branch strategy. See [`docs/target-repo-branch-setup.md`](target-repo-branch-setup.md).

Production sync assumes merge commits are promoted to the configured `productionBranch` before dispatch fires.

---

## Token boundary

| Credential | Where | Purpose |
|------------|-------|---------|
| `HARNESS_CONFIG_JSON_B64` | Harness GHA secrets | Private config (sensitive metadata, not a write token) |
| `LINEAR_API_KEY`, `CURSOR_API_KEY`, `HARNESS_GITHUB_TOKEN` | Harness GHA secrets | Live harness phases |
| `VERCEL_TOKEN` | Harness GHA secret (conditional) | Required when a configured repo uses Vercel production deployment verification (`previewProvider: "vercel"` with distinct integration vs production branches) |
| `HARNESS_DISPATCH_TOKEN` | Target repo GHA secrets | Dispatch-only PAT scoped to harness repo |

Full matrix: [`docs/security.md`](security.md)

Do **not** put merge-capable tokens or Linear/Cursor keys in target repos or Vercel.

---

## Validation

```bash
npm run harness:doctor
HARNESS_CONFIG_PATH=/path/to/private.json npm run harness:doctor
npm test
npm run test:webhook
```

After setting `HARNESS_CONFIG_JSON_B64`, validate cloud config loading safely:

1. **Config smoke test:** `workflow_dispatch` with `sync_repo=harness` (or a repo where integration and production branches match) — expect no-op success when branches match.
2. **Target repo dry-run:** `workflow_dispatch` with `sync_repo=<your-repo-id>` and `sync_dry_run=true` (default) — inspects sync without Linear writes.
3. **Live sync:** set `sync_dry_run=false` only when ready for real Linear status updates.

See [`docs/production-sync-automation.md`](production-sync-automation.md) for dispatch examples. For `production_promoted` **repository_dispatch**, sync always runs live (no dry-run).
