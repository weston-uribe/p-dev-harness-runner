# M5.5 live sandbox smoke test

Browser-driven first-run smoke of Settings / Configure against disposable GitHub sandbox repos.

**Date:** 2026-07-09  
**Branch:** `m5.5-live-sandbox-smoke-hardening`  
**Model:** Composer 2.5 (local agent run)

## Sandbox resources

| Resource | URL |
|----------|-----|
| Harness sandbox | https://github.com/weston-uribe/pdh-smoke-harness-20260709-191523 |
| Target sandbox | https://github.com/weston-uribe/pdh-smoke-target-20260709-191523 |
| Target workflow PR | https://github.com/weston-uribe/pdh-smoke-target-20260709-191523/pull/1 |
| Install branch | `harness/setup-production-sync-smoke-target` |

## Harness secrets written (names only)

- `HARNESS_CONFIG_JSON_B64`
- `LINEAR_API_KEY`
- `CURSOR_API_KEY`
- `HARNESS_GITHUB_TOKEN`

Dummy operator values were used for Linear/Cursor/harness GitHub secret fields during smoke (`smoke-*-placeholder-20260709-191523`).

## Smoke path results

| Step | Result | Evidence |
|------|--------|----------|
| Page load / local setup summary | Pass | GUI at `http://127.0.0.1:3001/settings/configure` |
| Remote summary | Pass | Sandbox dispatch repo + smoke target config rendered |
| Harness secret preview/apply | Pass | UI success message; `gh secret list` on harness sandbox |
| Target workflow preview | Pass | Install branch + workflow path + `directProductionBranchWrite: false` |
| Target workflow apply (OAuth token without `workflow` scope) | Pass after fix | Sanitized error instead of raw GitHub JSON |
| Target workflow apply (workflow-capable token) | Pass | PR #1 opened; workflow file on install branch only |
| Target `main` unchanged | Pass | `main` SHA `ec535c5fe43c` ≠ install branch SHA `26409a7223ad` |

## Objective bugs found and fixed

1. **Raw GitHub JSON leaked to GUI on workflow apply failure** — `sanitizeGitHubSetupError` passed through JSON bodies unchanged. Fixed by parsing GitHub API JSON and formatting readable messages.
2. **Misleading workflow permission failures** — OAuth tokens without `workflow` scope return HTTP 403 (update) or misleading HTTP 404 (create) for `.github/workflows/*`. Fixed with workflow-specific sanitization and setup guidance in `docs/gui-remote-setup.md`.

## UX friction log

| Title | Symptom | Why it slows setup | Recommendation | Classification |
|-------|---------|-------------------|----------------|----------------|
| Workflow scope not surfaced in GUI | Apply fails until operator knows PAT needs `workflow` scope | First-run operators may use OAuth tokens that work for secrets but not workflow files | Documented in remote setup guide; error message now actionable | `small-obvious-fix` (docs + error text) |
| Password field preview trigger | `browser_fill` on secret fields did not always enable preview | Browser automation quirk; manual typing works | No product change | `log-only` |
| Port selection | GUI bound to 3001 when 3000 in use | Minor local dev confusion | Existing port fallback behavior | `log-only` |

## Safety confirmations

- No writes to `weston-uribe/agentic-product-development-harness`
- No writes to any non-sandbox target repo
- No Linear writes
- No live harness phases, cloud workflow dispatch, or repository dispatch events
- No tags or releases
- No private secrets committed to tracked files
- Sandbox repos are private

## Validation

| Check | Result |
|-------|--------|
| `npm run build` | Pass |
| `npm test` | Pass (537 tests) |
| `npm run test:webhook` | Pass (89 tests) |
| Disallowed project-reference grep | Zero matches |

## Cleanup

Disposable sandbox repos were left for inspection. **Do not delete without operator approval.**
