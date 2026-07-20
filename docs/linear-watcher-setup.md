# Linear watcher setup

Operator guide for the v0.3.0 event-driven auto-runner.

**Related:** [`docs/milestones/m8-linear-watcher.md`](milestones/m8-linear-watcher.md), [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`docs/security.md`](security.md), [`docs/releases/v0.3.0.md`](releases/v0.3.0.md)

---

## Overview

When a Linear issue moves to an **actionable trigger status**, the harness runs automatically in GitHub Actions — no local `npm run harness:run` required.

```text
Linear webhook → Vercel bridge → GitHub repository_dispatch → GitHub Actions → harness --phase auto
```

---

## 1. Vercel webhook bridge

### Create Vercel project

1. Link this repo to Vercel (production branch: `main`).
2. Deploy; endpoint path is `/api/linear-webhook`.

### Vercel environment variables (Production)

| Variable | Required | Notes |
|----------|----------|-------|
| `LINEAR_WEBHOOK_SECRET` | yes | From Linear webhook signing secret |
| `GITHUB_DISPATCH_TOKEN` | yes | See [GitHub dispatch token](#github-dispatch-token) |
| `GITHUB_DISPATCH_REPOSITORY` | no | Default: `weston-uribe/agentic-product-development-harness` |
| `GITHUB_DISPATCH_EVENT_TYPE` | no | Default: `linear_issue_status_changed` |
| `LINEAR_WEBHOOK_TIMESTAMP_TOLERANCE_MS` | no | Default: `60000` |
| `HARNESS_TEAM_KEY` | **yes in production** | Set to `WES` — reject non-team issue keys |

**Do not** put `LINEAR_API_KEY`, `CURSOR_API_KEY`, or merge-capable `GITHUB_TOKEN` in Vercel. See [`docs/security.md`](security.md) for the full token matrix.

### GitHub dispatch token

`GITHUB_DISPATCH_TOKEN` must be able to call `POST /repos/{owner}/{repo}/dispatches`:

| PAT type | Required permission |
|----------|---------------------|
| **Fine-grained** | **Contents: write** on `weston-uribe/agentic-product-development-harness` only |
| **Classic** | **`repo` scope** |

- Contents: read is **not** sufficient.
- Scope the token to the harness repo only (fine-grained PAT).
- This token triggers workflows; it does not need access to target repos.

---

## 2. GitHub Actions secrets

In repo **Settings → Secrets and variables → Actions**:

| Secret | Used by |
|--------|---------|
| `LINEAR_API_KEY` | All live harness phases |
| `CURSOR_API_KEY` | planning, implementation, revision, merge repair fallback |
| `HARNESS_GITHUB_TOKEN` | handoff, revision, merge — mapped to runtime `GITHUB_TOKEN` in the workflow |

`HARNESS_GITHUB_TOKEN` must be a PAT with access to **target repos** used by the harness (e.g. target-app), including classic `repo` scope or equivalent fine-grained permissions for PR read, checks, merge, and PR branch repair. Fine-grained PATs need **Contents: Read and write** plus **Pull requests: Read and write** on target repos.

Run `npm run harness:doctor -- --profile merge` with `GITHUB_TOKEN` set before enabling merge automation. Doctor verifies target base branches and token write permission used by integration repair.

Do **not** name the Actions secret `GITHUB_TOKEN` — GitHub reserves that name for the auto-generated workflow token. The workflow maps `HARNESS_GITHUB_TOKEN` → `env: GITHUB_TOKEN` for the harness CLI.

---

## 3. Linear webhook

1. Linear → **Settings → API → Webhooks → New webhook**
2. URL: `https://<vercel-project>.vercel.app/api/linear-webhook`
3. Team: WES (or all public teams)
4. Resource types: **Issue** only
5. Copy signing secret → Vercel `LINEAR_WEBHOOK_SECRET`

### Dispatch allowlist (bridge filter)

The webhook **only dispatches GitHub Actions** when the issue's **current status** is a human-owned entry point:

- Ready for Planning
- Ready for Build
- Needs Revision
- Ready to Merge

All other statuses return HTTP 200 with `{ "accepted": false, "reason": "ignored_status" }` and **do not** start GHA. This includes harness-owned intermediates (Planning, Building, PR Open, Code Review, PM Review, Merging, Merged / Deployed). Post-build Code Review is started by durable job handoff from the implementation/orchestration path, not by a PR Open webhook.

---

## 4. Manual validation gates

### Gate 1: Local / unit tests

```bash
npm install
npm test
npm run build
npm run generate:config-schema
npm run harness:doctor
```

Requires local `.env` with harness secrets for doctor checks.

### Gate 2: workflow_dispatch

1. Confirm GHA secrets are set.
2. Actions → **Harness Auto Runner** → Run workflow.
3. Input: `issue=WES-XX`, `phase=auto`.
4. Confirm harness runs in cloud; download artifact with `runs/WES-XX/<run-id>/`.

For canceled or stuck integration repair while the issue is **Merging**, use `workflow_dispatch` with `issue=WES-XX`, `phase=merge`, and `force=true`. v1 intentionally does not dispatch from **Merging** automatically.

### Gate 3: repository_dispatch

```bash
gh api repos/weston-uribe/agentic-product-development-harness/dispatches \
  -f event_type=linear_issue_status_changed \
  -f client_payload[issueKey]=WES-XX \
  -f client_payload[statusName]="Ready for Planning" \
  -f client_payload[linearDeliveryId]=manual-test-1 \
  -f client_payload[receivedAt]=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

Confirm GHA run starts and executes `harness:run --phase auto`.

Use a PAT with Contents: write (fine-grained) or `repo` scope (classic).

### Gate 4: Linear webhook live

1. Deploy Vercel endpoint; configure Linear Issue webhook.
2. Move test issue **Backlog → Ready for Planning** (or **Ready for Build**).
3. Confirm Vercel log shows dispatch; GHA run starts; harness executes correct phase.
4. Duplicate delivery: confirm idempotent skip, no harmful duplicate work.
5. **Negative — PM Review:** After handoff, confirm `{ "reason": "ignored_status" }` and **no GHA run**.
6. **Negative — Planning/Building:** Harness moves to transitional status; confirm `ignored_status`, no GHA.
7. **Negative — title edit:** Edit title only; confirm `ignored_event`, no GHA.

---

## 5. Local webhook testing

```bash
# Sign a fixture body
BODY=$(cat tests/fixtures/webhook/issue-ready-for-planning.json)
SIG=$(node -e "const c=require('crypto');console.log(c.createHmac('sha256',process.env.LINEAR_WEBHOOK_SECRET).update(process.argv[1]).digest('hex'))" "$BODY")

curl -X POST http://localhost:3000/api/linear-webhook \
  -H "Content-Type: application/json" \
  -H "Linear-Signature: $SIG" \
  -H "Linear-Delivery: test-uuid" \
  -H "Linear-Event: Issue" \
  -H "Linear-Timestamp: 1700000000000" \
  -d "$BODY"
```

Use `vercel dev` for local endpoint testing.

---

## 6. Recovery

| Scenario | Recovery |
|----------|----------|
| GHA run failed after successful dispatch | Re-run via `workflow_dispatch` with same issue key |
| Dispatch failed (webhook 500) | Linear retries automatically; fix token/repo config |
| Wrong phase / stuck issue | Manual status change to allowlisted trigger status |

---

## 7. Failure responses (webhook)

| HTTP | Body | Meaning |
|------|------|---------|
| 401 | `invalid_signature` / `timestamp_out_of_tolerance` | Reject; fix secret or clock |
| 200 | `ignored_status` | Expected for non-trigger statuses |
| 200 | `ignored_event` | Non-Issue or no status change |
| 200 | `missing_issue_key` | Payload unusable; check Linear config |
| 500 | `dispatch_failed` | GitHub dispatch failed; Linear will retry |
