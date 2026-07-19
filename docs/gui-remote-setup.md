# Remote setup GUI

Guided remote setup for harness repo GitHub Actions secrets and target-repo production sync workflow install PRs.

**v0.4.0:** The seven-step Configure GUI includes remote setup in Steps 2–3, 6–7. Step 7 **automatically** validates, merges, and verifies system-owned workflow install PRs when checks pass — it does not leave manual merge as the only path. Ordinary product implementation PRs remain governed by Linear status gates.

Packaged launch: `npx --yes p-dev-harness@0.4.0` — see [`docs/p-dev.md`](p-dev.md).

**Related:** [`docs/gui-local.md`](gui-local.md), [`docs/security.md`](security.md), [`docs/operator-config.md`](operator-config.md), [`docs/production-sync-automation.md`](production-sync-automation.md)

---

## Start

```bash
npm run harness:configure
```

Open **Settings / Configure** and scroll to **Remote setup**.

Requires `GITHUB_TOKEN` in `.env.local` for live GitHub status checks and apply paths. Development and CI use mocked providers — no live remote writes during automated validation.

For **target workflow install PR** writes, the token must also be able to create or update `.github/workflows/*` files on the target repo. Classic PATs need the `workflow` scope in addition to `repo`. Fine-grained PATs need Actions/workflows write permission on the target repo. Without this scope, GitHub may return a misleading `404 Not Found` instead of a clear permission error.

---

## Scope (Milestone 5 PR 2)

The remote setup section supports:

- harness dispatch repo resolution and access status
- harness repo Actions secret status (`present` / `missing` / `unknown` only)
- per-target-repo workflow status (`present` / `missing` / `differs` / `unknown`)
- preview + confirmation-gated harness repo Actions secret writes
- preview + confirmation-gated target workflow branch/PR install per configured repo
- manual copy-paste instructions beside each automated action

It does **not**:

- write Linear issues or comments
- trigger harness phases or cloud workflow dispatch
- write directly to target repo `main` or production branches
- bundle local + remote actions into a single “do everything” button
- store secret values in browser storage

---

## Remote setup flow

### Harness repo Actions secrets

1. Confirm `GITHUB_TOKEN` is configured in `.env.local`.
2. Review harness dispatch repo and secret status badges.
3. Enter only the secrets you want to create or update:
   - `LINEAR_API_KEY`
   - `CURSOR_API_KEY`
   - `HARNESS_GITHUB_TOKEN`
4. `HARNESS_CONFIG_JSON_B64` is generated server-side from validated `.harness/config.local.json` during apply — it is never shown in previews or API responses.
5. Click **Preview harness secrets** — required before apply.
6. Review the redacted plan (key names and actions only) and manual instructions.
7. Check the `remote-secret-write` confirmation and click **Apply harness secrets**.

### Target workflow install PR (per repo)

1. Open the card for each configured target repo.
2. Click **Preview workflow PR**.
3. Review the install branch name, workflow path, PR title, and manual instructions.
4. Check the `remote-repo-write` confirmation and click **Apply workflow PR**.

Branch name: `harness/setup-production-sync-<repoConfigId>`

Workflow path: `.github/workflows/trigger-harness-production-sync.yml`

PR title: `Install harness production sync workflow`

Base branch: `repos[].productionBranch` from harness config

If the workflow already matches on the production branch, apply returns `already-installed` and does not open a PR.

---

## API routes (local server only)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/setup/remote-summary` | GET | Remote status summary (no secret values) |
| `/api/setup/preview-harness-secrets` | POST | Dry-run harness secret write preview |
| `/api/setup/apply-harness-secrets` | POST | Confirmation-gated harness secret writes |
| `/api/setup/preview-target-workflow` | POST | Dry-run target workflow branch/PR preview |
| `/api/setup/apply-target-workflow` | POST | Confirmation-gated target workflow branch/PR install |

Route handlers parse input and delegate to `apps/gui/lib/setup-server.ts`. GitHub semantics live in setup-core provider code (`src/setup/github-remote-setup-live.ts`).

Apply requires `confirmed: true` and a matching preview `fingerprint`.

---

## Security

- `GITHUB_TOKEN` is loaded server-side from `.env.local` only.
- API responses never include raw tokens, generated `HARNESS_CONFIG_JSON_B64`, or existing GitHub Actions secret values.
- GitHub API errors are sanitized before returning to the GUI.
- Secret inputs are POST-only — never in GET routes, query params, or browser storage.
- Target workflow apply never writes directly to production or `main` branches.

See [`docs/security.md`](security.md).
