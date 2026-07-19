# Agentic Product Development Harness

**Current release: v0.4.0** — immutable embedded workspace provisioning

## Use the product

**Installed or globally linked:**

```bash
p-dev
```

**Published npm install (current registry command):**

```bash
npx --yes p-dev-harness@0.4.0
```

PDev automatically opens Initial Harness Configuration until setup is complete, then opens the Workflow page.

- Requires **Node.js 22+**
- Starts a local guided **Configure GUI**
- Provisions or reconnects a private operator harness workspace from the **embedded package snapshot** (0.3.1+)
- **macOS validated** for packaged launch; use `--no-open` on other platforms
- First-time provisioning can take several minutes; progress is shown in Configure
- Early-stage — not production SaaS

Full guide: [`docs/p-dev.md`](docs/p-dev.md)

## Develop the harness

Contributors and maintainers clone the source repository:

```bash
git clone https://github.com/weston-uribe/agentic-product-development-harness.git
cd agentic-product-development-harness
npm ci
npm run dev
```

For a global `p-dev` command linked to this checkout, run `npm run p-dev:install` once.

See [`docs/getting-started.md`](docs/getting-started.md).

## TL;DR

Cursor-first orchestration harness for turning structured Linear issues into GitHub PRs through a controlled AI-assisted workflow.

| Layer | Status |
|-------|--------|
| Product install | `p-dev-harness@0.4.0` on npm (public) |
| Agent provider | Cursor Cloud Agents only |
| Product system | Linear |
| SCM / PR | GitHub |
| Cloud runner | GitHub Actions |
| Preview / bridge | Vercel (when configured) |
| Canonical skills | Six implemented under `.agents/skills/` |

It is **not** provider-agnostic and **not** a production SaaS.

## Quick links

| Topic | Doc |
|-------|-----|
| **p-dev install guide** | [`docs/p-dev.md`](docs/p-dev.md) |
| Getting started (source) | [`docs/getting-started.md`](docs/getting-started.md) |
| Release contract (v0.4.0) | [`docs/releases/v0.4.0.md`](docs/releases/v0.4.0.md) |
| Release contract (v0.3.0) | [`docs/releases/v0.3.0.md`](docs/releases/v0.3.0.md) |
| Release contract (v0.2.0) | [`docs/releases/v0.2.0.md`](docs/releases/v0.2.0.md) |
| Security baseline | [`docs/security.md`](docs/security.md) |
| Provider portability | [`docs/provider-portability.md`](docs/provider-portability.md) |
| Skill architecture | [`docs/skills/skill-architecture.md`](docs/skills/skill-architecture.md) |
| Linear watcher setup | [`docs/linear-watcher-setup.md`](docs/linear-watcher-setup.md) |

## Why it exists

AI-assisted development makes it easy to generate code quickly. It does not, by itself, make product judgment, scope control, or review readiness visible. This harness structures the work so that:

- Product intent is captured before implementation
- AI execution happens in a bounded, reviewable context
- Outputs are evaluated against explicit criteria before humans sign off

## What this is

```text
Linear issue → planning/build/review phases → GitHub PR → Linear/status gate → merge or revision
```

SDK runners handle planning through merge and production sync. Linear status changes can trigger cloud runs automatically. `p-dev` provides guided onboarding without cloning this repository.

## Current capability

| Layer | Status |
|-------|--------|
| Product onboarding | `p-dev` guided Configure GUI (implemented) |
| Issue intake | ChatGPT prompt + Cursor skill + validate-issue CLI |
| Planning / implementation / handoff / revision / merge | SDK runners (implemented) |
| Production sync | SDK runner + optional dispatch (implemented) |
| Auto-run from Linear status | Webhook bridge + GitHub Actions (implemented) |
| Canonical harness skills | `issue-intake`, `code-health-audit`, `architecture-evolution-audit`, `security-audit`, `planner`, `implementation` |

## Configuration and portability posture

V0.3 is **Cursor-first** and **not provider-agnostic**. See [`docs/provider-portability.md`](docs/provider-portability.md).

## What is planned

See [`ROADMAP.md`](ROADMAP.md) for deferred work: `performance-cost-audit`, skill registry/package manager, runner-skill integration, automated eval contract, and future portability.

## What this repo does not claim

- Autonomous shipping without Linear/status gates
- Production-grade robustness or SaaS maturity
- Provider agnosticism
- Full isolated npm-installed issue lifecycle (setup validated; issue run not yet)
- Generic auto-merge for arbitrary product PRs

## Optional observability (packaged runtime)

Packaged `p-dev-harness` supports **optional, consent-gated** anonymous analytics and sanitized error reports. No telemetry is sent until you enable each category in Configure. Preferences are stored locally at `.harness/observability.local.json`.

See [`docs/observability-and-privacy.md`](docs/observability-and-privacy.md).

## License

MIT — see [`LICENSE`](LICENSE).
