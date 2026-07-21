# Getting started

Operator guide for the Product Development Harness.

**Current release:** v0.4.0 — see [`docs/releases/v0.4.0.md`](releases/v0.4.0.md)

## Choose your path

### Product managers — use p-dev (recommended)

```bash
p-dev
```

Or the current published npm command:

```bash
npx --yes p-dev-harness@0.4.0
```

PDev automatically opens Initial Harness Configuration until setup is complete, then opens the Workflow page.

- Node.js **22+** required (canonical pin: **22.23.1** / npm **10.9.8** via `.nvmrc`)
- Starts the guided Configure GUI
- Stores operator state under `~/.p-dev` (or `P_DEV_HOME` / `--workspace`)
- macOS validated for browser auto-launch; use `--no-open` elsewhere

Full guide: [`docs/p-dev.md`](p-dev.md)

### Contributors — clone the source repository

```bash
git clone https://github.com/weston-uribe/agentic-product-development-harness.git
cd agentic-product-development-harness
npm ci
npm run dev
```

To link a global `p-dev` command to this checkout: `npm run p-dev:install`

GitHub Codespaces is supported for source-based development. See [`docs/gui-local.md`](gui-local.md) and [`docs/gui-remote-setup.md`](gui-remote-setup.md).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js 22+ | Required for source and `p-dev` |
| Linear account | Team with harness workflow statuses |
| GitHub account | Harness repo, target repos, and tokens |
| Cursor API key | For live cloud agent phases |
| Vercel account | For webhook bridge (cloud automation) |

---

## Source repository setup

### Configuration

Use private operator config — see [`docs/operator-config.md`](operator-config.md).

**Recommended local setup:**

1. `npm ci && npm run build`
2. `npm run harness:configure` — guided Configure GUI
3. Or `npm run harness:operator:init` — CLI scaffold
4. `npm run harness:doctor` — validates config
5. Base64-encode `.harness/config.local.json` for GitHub Actions secret `HARNESS_CONFIG_JSON_B64`

### Where secrets go

| Secret class | Store here |
|--------------|------------|
| `LINEAR_API_KEY`, `CURSOR_API_KEY`, `HARNESS_GITHUB_TOKEN` | GitHub Actions secrets |
| `LINEAR_WEBHOOK_SECRET`, `GITHUB_DISPATCH_TOKEN` | Vercel production env |
| Local dev tokens | Untracked `.env.local` |

Full matrix: [`docs/security.md`](security.md)

---

## Local validation before live automation

```bash
npm run harness:validate-issue -- --file draft.md --intended-phase planning
npm run harness:run -- --issue WES-FIXTURE --dry-run --fixture tests/fixtures/issues/valid-target-app.md
npm run harness:doctor
```

---

## Live setup (production automation)

| Component | Guide |
|-----------|-------|
| Guided Configure GUI | [`docs/gui-local.md`](gui-local.md), [`docs/gui-remote-setup.md`](gui-remote-setup.md) |
| p-dev packaged path | [`docs/p-dev.md`](p-dev.md) |
| Linear webhook + Vercel bridge | [`docs/linear-watcher-setup.md`](linear-watcher-setup.md) |
| Target repo branch strategy | [`docs/target-repo-branch-setup.md`](target-repo-branch-setup.md) |
| Production sync | [`docs/production-sync-automation.md`](production-sync-automation.md) |
| Security baseline | [`docs/security.md`](security.md) |

---

## PM issue intake

1. Copy the entire [`.agents/skills/issue-intake/SKILL.md`](../.agents/skills/issue-intake/SKILL.md) into a normal ChatGPT conversation (standalone skill; harness does not run intake)
2. Review the proposed Linear issue set; approve creation (default status: Backlog)
3. Move each issue to Ready for Planning or Ready for Build when ready
4. Optionally validate the resulting issue contract: `npm run harness:validate-issue`

---

## What not to do

- Do not commit secrets
- Do not assume provider agnosticism — Cursor is the only implemented agent provider
- Do not create git tags or GitHub releases from doc PRs — follow [`docs/releases/release-process.md`](releases/release-process.md)

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `p-dev` ENOSPC from npm cache | Clear npm cache; do not delete `~/.p-dev` unless resetting operator state |
| Browser does not open | Use `--no-open` and open printed URL |
| `validate-issue` fails | Compare draft to [`templates/linear-issue.md`](../templates/linear-issue.md) |
| Auto-run does not trigger | Vercel env vars, Linear webhook URL, dispatch token scope |

Architecture: [`ARCHITECTURE.md`](../ARCHITECTURE.md) · Agents: [`AGENTS.md`](../AGENTS.md)
