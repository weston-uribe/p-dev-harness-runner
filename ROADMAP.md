# Roadmap

This roadmap is intentionally high-level. It describes likely future product directions, not committed delivery dates.

For shipped history, see [CHANGELOG.md](CHANGELOG.md).

## Now

- Harden post-v0.3.0 operator experience from real `p-dev` installs
- Local GUI operator runtime reliability (immutable `next start`, atomic publication; see ADR 0005)
- Validate a full issue lifecycle from an isolated npm-installed workspace
- Improve cross-platform packaged launch policy beyond macOS browser auto-open
- Continue validating the Linear → GitHub → Cursor workflow on real but private target repos
- Operator-initiated **Update PDev runner** from Settings → Deployments (implemented on debug branch; not yet a published release milestone)

## Next

- Skill registry/package manager and manifests
- Runner-skill prompt integration (`src/prompts/*.md` remain runner implementation details today)
- `performance-cost-audit` skill
- Automated eval/check runners where manual rubrics are currently used
- Stronger CI/security defaults for target repos

## Later

- Add additional agent providers after proving a second adapter end to end
- Support more preview/deployment providers
- Improve multi-repo and team workflows
- Automatic background upgrade/synchronization of already-created private harness workspaces (operator-initiated Update PDev runner is separate and already implemented in-tree)

## Shipped in v0.4.0

- Authoritative Linear→repo associations with paired cloud config fingerprint (`HARNESS_CONFIG_JSON_B64` + `HARNESS_CONFIG_FINGERPRINT`)
- Faster Step 1 provisioning via bulk authenticated git push / packaged object pack
- Operator release CLI `release:sync-managed-runner` for managed harness runner sync + configuration canary
- In-app Update PDev runner path exists but is **disabled by default** for 0.4 (`P_DEV_RUNNER_UPGRADE_UI_ENABLED`)
- FRE end-to-end release gate completed on the test workspace (FRE-1)

## Shipped in v0.3.1

- Immutable embedded workspace snapshot provisioning in `p-dev-harness@0.3.1`
- Package-owned GitHub git object provisioning without runtime template dependency
- Shared upload rate-limit coordination with default concurrency 2

## Shipped in v0.3.0

- Seven-step guided Configure GUI with confirmation-gated local and remote setup
- Codespaces-compatible source development path
- Six canonical harness skills under `.agents/skills/`
- Public `p-dev-harness@0.3.0` npm package with durable operator workspace
- Public template provisioning via `weston-uribe/p-dev-harness-template`
- Automated Vercel bridge configuration and signed webhook verification
- Guarded Step 7 workflow install PR finalization for system-owned setup PRs

## Not planned for v0.x

- Autonomous shipping without human-controlled status gates
- Generic auto-merge for arbitrary public PRs
- Provider-agnostic claims before multiple providers work end to end
- Production-grade SaaS/control-plane claims
