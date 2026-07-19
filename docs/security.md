# Security baseline (v0.3.0)

Operator guide for secrets, tokens, logging, and accepted automation risks for the public harness repo.

**Related:** [`docs/linear-watcher-setup.md`](linear-watcher-setup.md), [`docs/decisions/0001-cursor-first-v0.1.md`](decisions/0001-cursor-first-v0.1.md)

---

## Threat model

This repo is **public**. Untrusted users can read code, workflow definitions, and (for public repos) Actions logs. They **cannot** push to `main` or trigger secret-bearing workflows without write access or a dispatch token.

Trusted automation paths:

1. **Linear signed webhook** → Vercel bridge → `repository_dispatch`
2. **Target repo `main` push** → `production_promoted` dispatch (separate repo)
3. **`workflow_dispatch`** — limited by GitHub Actions write permission on this repo

**Pass B (implemented):** Branch protection ruleset on `main` — PR required, required status checks, no direct push, no force push. GitHub Actions allowed-actions allowlist is active.

---

## Packaged observability boundary

Optional packaged `p-dev` telemetry uses public ingestion tokens (Sentry DSN, PostHog project token) shipped in `observability.public.json`. These allow event submission only — not secret readback. Treat vendor data as **non-authoritative evidence**; never automate security actions or releases from telemetry alone.

Local observability preferences must not be copied into snapshots, GitHub, Vercel, or provisioned repositories. See [`docs/observability-and-privacy.md`](observability-and-privacy.md).

---

## Plain-English security model

The repo is public, but the secrets are not in the repo.

A public reader can see the code and workflow definitions. They cannot push to `main`, trigger trusted secret-bearing automation, write to Linear, or merge target repo PRs unless they have one of the trusted credentials or repo permissions.

The important boundary is credential access:

- Vercel can only dispatch the harness workflow.
- GitHub Actions holds the live harness secrets.
- Local `.env` files stay untracked.
- Target-repo write access comes from `HARNESS_GITHUB_TOKEN`, not from public repo visibility.

---

## Token scope matrix

| Secret | Where stored | Scope / permissions | Can write GitHub? | Can write Linear? | Risk if leaked |
|--------|-------------|---------------------|-------------------|-------------------|----------------|
| `LINEAR_WEBHOOK_SECRET` | Vercel | HMAC signing for Linear webhooks | No | Indirect (forge webhook → dispatch) | High |
| `GITHUB_DISPATCH_TOKEN` | Vercel, target repo | Fine-grained **Contents: write** on harness repo only | Triggers workflows only | No | High |
| `LINEAR_API_KEY` | GitHub Actions secrets | Linear API as token owner | No | **Yes** | Critical |
| `CURSOR_API_KEY` | GitHub Actions secrets | Cursor Cloud Agents | No (Cursor-side) | No | High |
| `HARNESS_GITHUB_TOKEN` | GitHub Actions secrets | Target repos: PR merge/repair | **Yes** (configured target repos) | No | Critical |
| `HARNESS_CONFIG_JSON_B64` | GitHub Actions secrets | Private harness config JSON (base64) | No | No | High (reveals repo URLs, branch strategy) |

---

## Vercel environment (webhook bridge only)

Store **only**:

| Variable | Required | Notes |
|----------|----------|-------|
| `LINEAR_WEBHOOK_SECRET` | yes | Linear webhook signing secret |
| `GITHUB_DISPATCH_TOKEN` | yes | Harness-repo-scoped dispatch PAT |
| `HARNESS_TEAM_KEY` | **yes in production** | Set to `WES` — reject non-team issue keys |

Optional: `GITHUB_DISPATCH_REPOSITORY`, `GITHUB_DISPATCH_EVENT_TYPE`, `LINEAR_WEBHOOK_TIMESTAMP_TOLERANCE_MS`.

**Do not** store `LINEAR_API_KEY`, `CURSOR_API_KEY`, or merge-capable `GITHUB_TOKEN` / `HARNESS_GITHUB_TOKEN` in Vercel.

---

## GitHub Actions secrets

| Secret | Used by |
|--------|---------|
| `HARNESS_CONFIG_JSON_B64` | All harness jobs (private operator config) |
| `LINEAR_API_KEY` | All live harness phases |
| `CURSOR_API_KEY` | planning, implementation, revision, merge repair |
| `HARNESS_GITHUB_TOKEN` | Mapped to runtime `GITHUB_TOKEN` for **target** repo operations |
| `P_DEV_STATE_GITHUB_TOKEN` | Contents R/W on the **private state** repository only |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Evaluation inspect / projection canaries (manual) |

Repository **variables** (not secrets): `HARNESS_CONFIG_FINGERPRINT`, `P_DEV_WORKFLOW_STATE_REPOSITORY`, `P_DEV_WORKFLOW_STATE_BRANCH`, `P_DEV_JOB_REQUEST_REPOSITORY`, `P_DEV_PUBLIC_RUNNER_MODE`, `P_DEV_EVALUATION_*`, `LANGFUSE_BASE_URL`, `LANGFUSE_TRACING_ENVIRONMENT`.

`HARNESS_GITHUB_TOKEN` must have access to **target repos** in the resolved harness config (classic `repo` or fine-grained **Contents: Read and write** + **Pull requests: Read and write** on each target). Target repos are typically defined in private config via `HARNESS_CONFIG_JSON_B64` — see [`docs/operator-config.md`](operator-config.md).

`P_DEV_STATE_GITHUB_TOKEN` must **not** be the same unrestricted token as target operations when practical. Scope it to the private state repository (`Contents: Read and write`).

Do **not** name the Actions secret `GITHUB_TOKEN` — GitHub reserves that for the auto-generated workflow token.

### Public execution repository

When `P_DEV_PUBLIC_RUNNER_MODE=1`, workflows must use allowlisted public logging only. Issue keys, target repo names, PR URLs, plan/review bodies, and diffs must not appear in step summaries, artifact names, concurrency groups, or job outputs. Job dispatch uses opaque `requestId` envelopes stored in the private state repository.

---

## PAT policy

- **Prefer fine-grained PATs** scoped to the minimum repos and permissions.
- **Classic PATs** are discouraged except as a documented fallback.
- `GITHUB_DISPATCH_TOKEN`: public execution repository `repository_dispatch` (+ optional state write on the bridge if not using a separate state token).
- `P_DEV_STATE_GITHUB_TOKEN`: private state repository Contents R/W only.
- `HARNESS_GITHUB_TOKEN`: target repos only, merge/repair permissions as needed.

---

## Secret handling rules

1. **Rotate immediately** if a secret is exposed (logs, commit, artifact, comment).
2. **No structured JSON secrets** — store plain string env vars, not JSON blobs.
3. **Never commit** secrets to the repo, docs, tests, or examples.
4. **Never log** raw tokens — harness redacts stdout before logs, summaries, and artifacts.
5. Raw command output may exist only as a **temporary file in the same workflow step**; it must be deleted before artifact upload.

### Local GUI secret handling (Milestone 4–5)

The local Product Development Harness GUI (`npm run harness:gui`) handles secrets with these boundaries:

- Existing `.env.local` secret values are never sent to the browser — only key presence (`Set` / `Missing`).
- Existing harness repo GitHub Actions secret values are never readable — only `present` / `missing` / `unknown` status.
- Newly entered secrets exist only in transient form state and POST bodies to the local Next.js server.
- Preview responses redact secret assignment lines and never include `HARNESS_CONFIG_JSON_B64` generated values.
- Apply requires explicit confirmation and a matching server-side preview fingerprint per action.
- Separate confirmations are required for `remote-secret-write` (harness repo Actions secrets) and `remote-repo-write` (target workflow branch/PR install).
- The GUI does not persist secrets in `localStorage`, `sessionStorage`, cookies, or URL query params.
- Local GUI apply writes only `.env.local` and `.harness/config.local.json` on the operator machine.
- Remote GUI apply writes only encrypted harness repo Actions secrets and target-repo install branches/PRs — never directly to target production or `main` branches.

See [`docs/gui-local.md`](gui-local.md) and [`docs/gui-remote-setup.md`](gui-remote-setup.md).

---

## Accepted risks

| Risk | Mitigation |
|------|------------|
| `repository_dispatch` is not Linear-signed | Requires possession of `GITHUB_DISPATCH_TOKEN` |
| `workflow_dispatch` can target arbitrary issue keys | Limited to users with Actions write on this repo; optional `harness-manual` environment |
| Dispatch bypasses webhook status filter | `resolve-route` uses live Linear state; cannot force wrong phase via fake payload status |
| Public Actions logs | Redacted harness output only in logs/summaries/artifacts |

---

## Pinned Actions (verified 2026-07-08)

Re-resolve SHAs before updating refs:

| Action | Tag | SHA |
|--------|-----|-----|
| `actions/checkout` | v4 | `34e114876b0b11c390a56381ad16ebd13914f8d5` |
| `actions/setup-node` | v4 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/upload-artifact` | v4 | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `github/codeql-action` | v3 | `641a925cfafe92d0fdf8b239ba4053e3f8d99d6d` |

Dependabot opens PRs for npm and GitHub Actions updates weekly.

---

## Known transitive vulnerabilities

`npm audit --audit-level=moderate` may report **high** severity issues in `undici` (transitive via `@cursor/sdk` → `@connectrpc/connect-node`). As of v0.3.0, **no fix is available** upstream. Accepted risk — track `@cursor/sdk` releases; do not add force-resolutions without upstream guidance.

---

## OpenSSF Scorecard

**Deferred.** Scorecard uses third-party `ossf/scorecard-action`, which would require expanding the Actions allowlist and adds release noise. CodeQL + CI are the current baseline.

---

## Pass B — branch protection and solo repo policy (implemented)

The following operator settings are **active** on this repo:

| Setting | Status |
|---------|--------|
| Ruleset on `main` (PR required, status checks, no force push) | **Implemented** |
| Required status checks: `test`, `Analyze (javascript-typescript)` | **Implemented** |
| Actions allowed-actions allowlist | **Implemented** |
| `.github/CODEOWNERS` for `.github/workflows/**` | **File exists** — documents ownership |
| Required GitHub approvals | **0** (solo-maintainer mode) |
| CODEOWNER review enforced | **No** (not required while solo maintainer) |
| Direct push to `main` | **Blocked** |

### Solo-maintainer automation policy

While Weston is the only maintainer:

- Changes reach `main` via **PR + required checks** — not direct push.
- **Required GitHub approvals are 0** — merge does not wait for a separate human reviewer.
- **Linear/status gates remain required** — harness automation respects allowlisted Linear statuses; merge runs only after **Ready to Merge**.

### When to re-enable approvals and CODEOWNER review

Turn on required GitHub approvals and enforce CODEOWNER review when:

- A second engineer joins as maintainer, or
- The repo begins accepting external contributions

At that point, update the ruleset to require approvals and enable CODEOWNER review for `.github/workflows/**` changes.

### Optional (not required for v0.3.0)

- `harness-manual` environment for `workflow_dispatch` — adds an approval gate for manual cloud runs if desired later.

**Release contract:** [`docs/releases/v0.3.0.md`](releases/v0.3.0.md) (current), [`docs/releases/v0.2.0.md`](releases/v0.2.0.md) (historical)
