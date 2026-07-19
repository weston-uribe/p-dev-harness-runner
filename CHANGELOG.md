# Changelog

All notable changes to this harness repo are documented here.

V0.3.0 is a **GitHub source release** plus a **public npm CLI package** (`p-dev-harness@0.3.0`). The root repository remains `private: true`; the published package is `packages/p-dev`.

## Unreleased

_(none reserved for post-0.4.0 work yet)_

## [0.4.0] — 2026-07-18

Minor release: authoritative Linear associations + cloud config fingerprint gate, faster Step 1 provisioning, operator `release:sync-managed-runner`, and managed-runner upgrade plumbing with the in-app Update card **disabled by default**.

**Release type:** GitHub source release plus public npm package `p-dev-harness@0.4.0` (publish/tag gated on operator approval after release-prep PR).

**Release contract:** [`docs/releases/v0.4.0.md`](docs/releases/v0.4.0.md)

### Added

- Authoritative Linear→repo associations for issue routing; Configure Step 2 reuses Settings associations
- Paired `HARNESS_CONFIG_JSON_B64` + `HARNESS_CONFIG_FINGERPRINT` cloud config check (`cloud_config_stale` fail-closed), including `run-merge`
- Configuration canary diagnostics (expected/computed fingerprint, decode + association success) and `canary_operation_id` run location after workflow_dispatch 204
- Operator CLI `release:sync-managed-runner` for known managed harness runner sync + required canary
- Update PDev runner upgrade flow (Settings Deployments card) behind `P_DEV_RUNNER_UPGRADE_UI_ENABLED` (off by default for 0.4)
- Step 1 bulk authenticated git push / packaged Git object pack provisioning path

### Fixed

- Guided Configure hold-on-success UX (Steps 1–6) and Step 7 server-authoritative finalization / branch recovery
- Runner status comments and conditional Blocked finalization during upgrade sync windows
- Runner-upgrade status deadlocks and false Deployments progress; release sync monorepo snapshot load for source checkouts

### Changed

- Create-new Vercel bridge auto-deploy before probe; Configure header/select layout polish
- In-app runner update experience deferred — flag-gated only for 0.4

### Compatibility

- Existing valid 0.3.0 / 0.3.1 managed workspaces reconnect; operator sync CLI available for the known release test harness
- `weston-uribe/p-dev-harness-template` remains frozen legacy artifact for 0.3.0

### Also included since 0.3.1 (already on `main` before this cut)

- Configure GUI data-sharing onboarding gate and Settings **Data sharing** route; observability nonce for local preference writes
- Builder thread continuity (canonical Cursor Builder lineage across revision/repair) with hidden Linear lineage metadata
- Canonical product-development workflow descriptor, fail-closed Linear workflow preflight, Workflow page + `roleModels`
- Guided Configure header/progress/motion polish and autonomous Vercel bridge verification

## [0.3.1] — 2026-07-14

Patch release: immutable package-owned workspace snapshots for `p-dev-harness` provisioning plus narrowly scoped release-impact agent-contract improvements.

**Release type:** GitHub source release plus public npm package `p-dev-harness@0.3.1`.

**RELEASE_SHA:** `995387c74334ba85206d9d87d7d78d4ecbfa8361` (merge commit for PR #60)

### Added

- Deterministic embedded `workspace-snapshot/` generation from immutable Git commits during `package:p-dev:prepare`
- Package-owned GitHub provisioning (`auto_init`, snapshot commit, marker commit v3) without runtime dependency on `weston-uribe/p-dev-harness-template`
- Conditional release-impact analysis in canonical planner skill and runtime planning prompt
- Release contract [`docs/releases/v0.3.1.md`](docs/releases/v0.3.1.md) (published)

### Changed

- Default snapshot blob-upload concurrency **2** with strict `HARNESS_SNAPSHOT_UPLOAD_CONCURRENCY` validation and shared GitHub rate-limit gate
- Release process docs: snapshot/manifest/tarball validation replaces template synchronization for 0.3.1+
- Architecture docs: embedded snapshot is provisioning source for 0.3.1+; public template frozen for 0.3.0 legacy compatibility
- Implementation skill/prompt preserve planner release boundaries and report outstanding release preparation

### Compatibility

- Existing valid `p-dev-harness@0.3.0` managed workspaces reconnect without content rewrite
- `weston-uribe/p-dev-harness-template` remains frozen legacy artifact for 0.3.0; not used by 0.3.1+ provisioning

## [0.3.0] — 2026-07-13

V0.3.0 is the guided-onboarding and distribution release: seven-step Configure GUI, six canonical skills, and public `p-dev-harness` npm package.

**Release type:** GitHub source release (annotated tag + curated release notes) plus public npm package `p-dev-harness@0.3.0`.

### Highlights

- Guided seven-step Configure GUI repaired and automated end to end
- Public `p-dev-harness` package — launch without cloning the source repository
- Six canonical harness skills under `.agents/skills/`
- Public template provisioning for private `OWNER/p-dev-harness` workspaces
- Automated Vercel bridge setup with redeploy polling and signed webhook verification
- Guarded Step 7 workflow install PR finalization for system-owned setup PRs

### Added

- Canonical end-user guide [`docs/p-dev.md`](docs/p-dev.md)
- Public npm package `p-dev-harness@0.3.0` with durable operator workspace (`~/.p-dev`, `P_DEV_HOME`, `--workspace`)
- Packaged harness workspace provisioning/reconnection from `weston-uribe/p-dev-harness-template`
- Seven-step guided Configure GUI with confirmation-gated local and remote writes
- Remote setup: Linear workspace/status configuration, Vercel bridge, cloud secrets, target workflow install
- Automatic Vercel production redeploy polling and signed webhook verification
- Step 7 workflow install PR validation, guarded merge, and production verification
- Six canonical skills: `issue-intake`, `code-health-audit`, `architecture-evolution-audit`, `security-audit`, `planner`, `implementation`
- Skill architecture documentation at [`docs/skills/skill-architecture.md`](docs/skills/skill-architecture.md)
- Release contract [`docs/releases/v0.3.0.md`](docs/releases/v0.3.0.md)
- Package publication process in [`docs/releases/release-process.md`](docs/releases/release-process.md)

### Changed

- README leads product managers to `npx --yes p-dev-harness@0.3.0`; source clone remains contributor path
- `docs/getting-started.md` — p-dev primary, source clone for maintainers
- `docs/npm-packaging-spike.md` — historical spike document linking to `docs/p-dev.md`
- `packages/p-dev/README.md` — public npm package README
- Root `package.json` version `0.2.0` → `0.3.0` (source marker; `private: true` unchanged)
- `RELEASE_PHASE` `v0.2-prep` → `v0.3-prep`
- ROADMAP reflects post-v0.3 priorities; shipped v0.3 items moved to history

### Fixed

- Guided setup step order and navigation (seven stages before completion)
- npm package published as `p-dev-harness` after registry rejected `p-dev` as too similar to `pdev`
- Packaged workspace seeding without overwriting existing operator files
- Durable repo ID / managed-marker recovery for provisioned harness workspaces
- Server-authored evidence for cloud secret setup
- Target workflow PR reuse, exact-content validation, and production verification

### Security and safety

- Confirmation-gated remote mutations with fingerprint validation
- Error redaction and permission handling in setup flows
- Published package excludes credentials, local state, and generated private workspace artifacts
- MIT license included in npm package artifact

### Documentation

- Truth audit across README, AGENTS, ARCHITECTURE, ROADMAP, operator and GUI docs
- Token permission documentation derived from implementation (classic `repo` + `workflow`; fine-grained Contents + Workflows write)
- Explicit distinction: system-owned setup PR automation does not alter ordinary product PR policy

### Validation

- Codespaces source-based GUI validation
- Controlled separate-account packaged onboarding through Setup complete
- Package pack/inspect tests, tarball smoke, Configure route HTTP 200
- Expanded setup, GUI, and provisioning test coverage

### Known limitations

- **Cursor-only** agent provider
- **Linear / GitHub / GitHub Actions / Vercel** stack only
- **macOS validated** for packaged browser auto-launch; use `--no-open` elsewhere
- **No full real issue lifecycle** from an isolated npm-installed workspace
- **No automatic upgrade/sync** of already-created private harness workspaces
- **Public template compatibility** dependency on `weston-uribe/p-dev-harness-template`
- **Not production-grade SaaS** or provider-agnostic
- Manual eval rubrics remain where automation is not implemented
- Deferred: `performance-cost-audit`, skill registry/package manager, manifests, provider adapters, runner-skill prompt integration

[0.3.0]: https://github.com/weston-uribe/agentic-product-development-harness/releases/tag/v0.3.0
[0.2.0]: https://github.com/weston-uribe/agentic-product-development-harness/releases/tag/v0.2.0

## [0.2.0] — 2026-07-08

V0.2.0 moves the harness from early validated spikes to a documented source release: lifecycle runners, Linear-triggered GitHub Actions automation, production sync, provider posture, security hardening, and operator docs now tell one consistent story.

**Release type:** GitHub source release (annotated tag + GitHub release).

### Added

- SDK lifecycle runners: planning, implementation, handoff, revision, merge, and production sync
- Event-driven auto-runner: Linear webhook → Vercel bridge → `repository_dispatch` → GitHub Actions → `harness run --phase auto`
- Trigger statuses: Ready for Planning, Ready for Build, PR Open, Needs Revision, Ready to Merge
- Explicit `agentProvider.id: "cursor"` config shape and internal provider seam (`src/agents/`)
- Issue intake: ChatGPT copy-paste prompt, Cursor issue-intake skill, parser-aligned template, `harness validate-issue` CLI
- Production sync automation (`harness:sync-production`) with optional `production_promoted` dispatch
- Target-repo integration-branch posture: PRs target `dev`; manual `dev` → `main` promotion; sync updates Linear
- GitHub Actions hardening: pinned actions, env-var shell safety, output redaction
- CI / CodeQL / Dependabot
- Public-repo security baseline and operator guides
- Release contract (`docs/releases/v0.2.0.md`), release process, operator getting-started guide

### Changed

- Harness positioned as Cursor-first for Linear + GitHub + GitHub Actions (not provider-agnostic)
- Solo repo automation policy: PR required + required checks + no direct push to `main`; **0 required GitHub approvals** while solo-maintainer
- `package.json` version marker `0.1.0` → `0.2.0` (source release only; `private: true` unchanged)

### Security

- Branch protection ruleset active on `main` (PR required, required status checks, no force push)
- GitHub Actions allowed-actions allowlist (pinned first-party actions)
- Secrets confined to GitHub Actions secrets, Vercel env vars, or local untracked `.env` files
- Harness output redaction before logs, summaries, and artifacts
- `.github/CODEOWNERS` documents ownership of workflow files (not enforced as required review in solo mode)

### Documentation

- Truth audit across README, ROADMAP, ARCHITECTURE, AGENTS, security, and operator guides
- Provider portability posture (`docs/provider-portability.md`)
- Linear watcher setup, target-repo branch setup, production sync automation guides

### Known limitations

- Cursor Cloud Agents are the **only** implemented agent provider
- Linear is the only implemented product/control system; GitHub is the only SCM/PR system
- Vercel is the only implemented preview provider when preview capture is enabled
- Not provider-agnostic; no Claude Code, Codex, local VS Code agents, GitLab, or Bitbucket support
- Evals remain manual rubrics — automated eval contract is deferred
- Not production-grade portable; not a plug-and-play product
- OpenSSF Scorecard deferred
- No generic auto-merge for arbitrary green public PRs
- Linear/status gates required — automation does not ship without human-controlled status transitions
