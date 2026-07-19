# Release process

Operator guide for harness releases: GitHub source release plus public npm package `p-dev-harness`.

**Related:** [`v0.4.0.md`](v0.4.0.md) (current release contract), [`v0.3.1.md`](v0.3.1.md) / [`v0.3.0.md`](v0.3.0.md) (historical), [`CHANGELOG.md`](../../CHANGELOG.md), [`docs/p-dev.md`](../p-dev.md)

## Variables

Use these placeholders throughout:

| Variable | Example | Meaning |
|----------|---------|---------|
| `VERSION` | `0.4.0` | SemVer package/root version |
| `TAG` | `v0.4.0` | Annotated git tag |
| `RELEASE_SHA` | merge commit on `main` | Exact post-merge release commit |
| `TARBALL` | `packages/p-dev/p-dev-harness-0.4.0.tgz` | Exact npm publish artifact |

## Summary

The release process has distinct phases:

1. **Release-preparation PR** — versions, docs, tests, release contract (no tag/npm/release mutations)
2. **Embedded workspace snapshot validation** — deterministic snapshot/manifest generation from clean `RELEASE_SHA` checkout
3. **Exact tarball validation** — build and smoke-test `TARBALL` at `RELEASE_SHA`
4. **npm publication** — publish the exact validated tarball
5. **Annotated git tag** — primary `TAG` at `RELEASE_SHA`
6. **GitHub release** — curated notes from `docs/releases/v<VERSION>.md`
7. **Post-release finalization PR** — record immutable tag/npm evidence

Do **not** push directly to `main`, force-push, overwrite tags, or republish npm versions.

### Legacy template containment (v0.3.0 only)

`weston-uribe/p-dev-harness-template` is a **frozen legacy compatibility artifact** for `p-dev-harness@0.3.0` template-based provisioning.

For **0.3.1 and later**:

- Do **not** advance, repurpose, or resync the template repository `main` branch for new package versions.
- Do **not** move or recreate the existing template `v0.3.0` tag.
- Snapshot transparency comes from the primary repository release commit plus the npm tarball `workspace-snapshot/manifest.json`.

---

## Phase 1 — Release-preparation PR

Merge to `main`:

- Version bumps (`VERSION` root, `p-dev-harness@VERSION`)
- `CHANGELOG.md`, `docs/releases/v<VERSION>.md`, truth-audit docs
- Package publication metadata and tests
- Validation on the PR branch

**Do not run during the release-prep PR:**

- `git tag`, `git push` (tags)
- `npm publish`
- `gh release create`
- Live remote setup mutations against production destinations

---

## Phase 2 — Embedded workspace snapshot validation

After primary release-prep PR merges:

1. Record `RELEASE_SHA` (merge commit on `main`)
2. From a **clean checkout** at `RELEASE_SHA`, run:

```bash
git checkout "$RELEASE_SHA"
npm ci
npm run build
npm run package:p-dev:prepare
npm run package:p-dev:pack
```

Package preparation requires a clean working tree with `HEAD` equal to `RELEASE_SHA`. Do **not** use `P_DEV_SNAPSHOT_SOURCE_REF`.

3. Inspect `packages/p-dev/workspace-snapshot/manifest.json`:
   - `packageVersion` matches `packages/p-dev/package.json`
   - `sourceCommit` equals `RELEASE_SHA`
   - `snapshotSha256`, `snapshotContentId`, and `gitRootTreeSha1` are present
4. Inspect the packed tarball:
   - Contains `package/workspace-snapshot/manifest.json` and curated `package/workspace-snapshot/files/**`
   - Excludes local secrets, operator state, generated caches, and unrelated generated package outputs
5. Record tarball byte size and SHA-256 for release evidence

**Do not** mutate `weston-uribe/p-dev-harness-template` for 0.3.1+ releases.

---

## Phase 3 — npm preflight

Before publication:

```bash
npm config get registry
npm whoami --registry=https://registry.npmjs.org/
npm view p-dev-harness --registry=https://registry.npmjs.org/ --json
npm view p-dev-harness@VERSION --registry=https://registry.npmjs.org/ --json
```

**Stop** if:

- Not authenticated or not authorized to publish
- `p-dev-harness@VERSION` already exists with **different bytes** than the intended `TARBALL`
- Package name is owned by someone else

If `p-dev-harness@VERSION` already exists with **identical bytes**, treat npm publication as complete and reconcile tag/release against the same `RELEASE_SHA`.

Never print tokens, OTPs, or secrets.

---

## Phase 4 — Exact tarball and validation

At `RELEASE_SHA` in a clean working tree:

```bash
git checkout "$RELEASE_SHA"
npm ci
npm run build
npm test
npm run test:webhook
npm run package:p-dev:prepare
npm run package:p-dev:pack
npm run package:p-dev:inspect
```

Record tarball bytes, SHA-1, SHA-256, manifest, unpacked size, file count.

Tarball launcher smoke (fresh `P_DEV_HOME`):

```bash
TARBALL="packages/p-dev/p-dev-harness-VERSION.tgz"
WORKDIR=$(mktemp -d)
export P_DEV_HOME="$WORKDIR/workspace"
cd "$WORKDIR"
npx --yes "file:/absolute/path/to/$TARBALL" --no-open
# verify /settings/configure HTTP 200, stop, relaunch with same P_DEV_HOME
```

Dry-run publish:

```bash
npm publish "$TARBALL" --dry-run --access public --registry=https://registry.npmjs.org/
```

---

## Phase 5 — npm publication

Publish the **exact already-tested tarball** (do not rebuild between smoke and publish):

```bash
npm publish "$TARBALL" --access public --registry=https://registry.npmjs.org/
```

If npm requests OTP, enter it interactively. **Never** place OTP or token in files, commands reported in PRs, or logs.

Verify:

```bash
npm view p-dev-harness@VERSION name version dist-tags.latest dist.shasum dist.integrity engines bin repository license
```

Registry smoke from fresh directory:

```bash
WORKDIR=$(mktemp -d)
export P_DEV_HOME="$WORKDIR/workspace"
cd "$WORKDIR"
npx --yes p-dev-harness@VERSION --no-open
```

---

## Phase 6 — Primary tag and GitHub release

**After** npm publication verification:

```bash
git tag -a "$TAG" "$RELEASE_SHA" -m "$TAG"
git rev-parse "$TAG^{}"   # must equal RELEASE_SHA
git push origin "$TAG"
```

Verify remote tag resolves to `RELEASE_SHA`.

Create GitHub release:

```bash
gh release create "$TAG" \
  --title "$TAG — Immutable workspace provisioning" \
  --notes-file "docs/releases/v$VERSION.md" \
  --latest
```

- Do **not** use `--generate-notes` as primary body
- Do **not** mark prerelease unless an actual blocker requires it
- Do **not** overwrite an existing tag (`git tag -f`, `git push --force`)

If npm succeeds but GitHub release fails: **do not republish**. Recover tag/release against the same `RELEASE_SHA`.

---

## Phase 7 — Post-release finalization PR

Branch `docs/finalize-v<VERSION>-release`:

- Update `docs/releases/v<VERSION>.md` with tagged/published status, URLs, SHAs, registry shasum/integrity, tarball metadata, live validation evidence, registry smoke result, timestamp
- Do **not** change released package contents or version

Merge after checks pass.

---

## V0.4.0 — exact commands (current example)

```bash
VERSION=0.4.0
TAG=v0.4.0

# After release-prep PR merge
RELEASE_SHA=$(git rev-parse origin/main)
git checkout main && git pull --ff-only origin main
git checkout "$RELEASE_SHA"

# Validate at release commit
npm ci && npm run build && npm test && npm run test:webhook
npm run package:p-dev:prepare && npm run package:p-dev:pack && npm run package:p-dev:inspect
TARBALL="packages/p-dev/p-dev-harness-${VERSION}.tgz"

# npm preflight + publish (interactive OTP if required)
npm whoami --registry=https://registry.npmjs.org/
npm view p-dev-harness@${VERSION} --registry=https://registry.npmjs.org/
npm publish "$TARBALL" --access public --registry=https://registry.npmjs.org/

# Tag and release
git tag -a "$TAG" "$RELEASE_SHA" -m "$TAG"
git push origin "$TAG"
gh release create "$TAG" \
  --title "$TAG — Immutable workspace provisioning" \
  --notes-file "docs/releases/v${VERSION}.md" \
  --latest
```

---

## V0.3.0 — historical commands

V0.3.0 used public-template provisioning. See [`v0.3.0.md`](v0.3.0.md) for the historical contract.

---

## Operator notes

### Root repo vs npm package

| Artifact | `private` | Published |
|----------|-----------|-----------|
| Root `agentic-product-development-harness` | `true` | GitHub source release only |
| `packages/p-dev` (`p-dev-harness`) | no | Public npm |

### What not to run during release-doc PRs

- `git tag`, `git push` (tags)
- `npm publish`
- `gh release create`
- Live `harness:run` against production issues
- Linear writes
- Secret inspection, printing, or rotation in reports

---

---

## Observability release-readiness validation

When shipping observability changes in `p-dev-harness`, run these checks at the stacked release-readiness tip in a **clean committed working tree** before any npm publication approval:

```bash
npm ci
npm run build
npm test
npm run test:webhook
npm run package:p-dev:prepare
npm run package:p-dev:pack
npm run package:p-dev:inspect
npm test -- tests/observability/packaged-config.test.ts tests/p-dev/package-packed-artifact.test.ts
```

Record tarball path, bytes, SHA-1, SHA-256, manifest source commit, and packed entry count.

Installed-tarball smoke (fresh temp dir + fresh `P_DEV_HOME`, fake/local capture only):

```bash
TARBALL="packages/p-dev/p-dev-harness-VERSION.tgz"
WORKDIR=$(mktemp -d)
export P_DEV_HOME="$WORKDIR/workspace"
mkdir -p "$P_DEV_HOME"
npx --yes "file:$(pwd)/$TARBALL" --no-open &
PID=$!
# wait for http://127.0.0.1:PORT/settings/configure → 200
# GET /api/observability/preferences → undecided, no installation ID
# verify no outbound Sentry/PostHog requests before consent
# verify route security rejects wrong Host, origin, nonce, and malformed bodies
kill "$PID"
```

**Stop** if:

- `observability.public.json` contains privileged credentials, PostHog personal API keys (`phx_`), or Sentry auth/management tokens
- Tarball ships `.harness/observability.local.json`, nonce fixtures, or maintainer overrides
- Pre-consent network transmission occurs in smoke
- Sentry payloads include stable installation ID
- the public DSN appears outside `config/observability.public.json` and the established generated package mirror
- browser-side Sentry initialization, CI/Vercel source-map upload, source-context upload, or build/runtime `SENTRY_AUTH_TOKEN` dependency is introduced

**Required before observability-enabled release approval:**

- Sentry public DSN committed only to the tracked public config source
- Legacy PostHog `Default Project` deleted and clean `p-dev-harness` project created (US region)
- Public PostHog project ingestion token (`phc_…`, not `phx_`) committed only to `config/observability.public.json` and the package mirror
- `p-dev Packaged Onboarding Health` dashboard matches [`src/observability/posthog-dashboard-contract.ts`](../src/observability/posthog-dashboard-contract.ts)
- Vendor sandbox payload verification with raw stored event JSON (not UI summaries alone)
- Mandatory Sentry project privacy settings verified live:
  - Data Scrubber and Default Scrubbers enabled
  - Prevent Storing of IP Addresses
  - Advanced Data Scrubbing: `[Remove] [Anything] from [$user.geo.**]`
  - Advanced Data Scrubbing: `[Remove] [Anything] from [contexts.trace]`
- Source maps, JavaScript source fetching, and SCM source context remain disabled
- Exposed Sentry client key revoked, deleted, disabled, or otherwise proven unusable before the replacement DSN is enabled

### Sentry sandbox privacy revalidation (operator-run)

Use the exact-head packaged tarball with the committed public DSN. Do not supply `P_DEV_SENTRY_DSN`, `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, or `SENTRY_AUTH_TOKEN` through private environment variables for this gate.

1. Fresh disposable `P_DEV_HOME` temp directory.
2. Install and launch the packed tarball with `npx p-dev-harness@VERSION --no-open` (real launcher, not a direct facade import).
3. Confirm zero Sentry traffic before consent (`GET /api/observability/preferences` undecided).
4. Enable **Automated sanitized error reports** only in Configure.
5. Trigger one captured product error without mutating GitHub, Linear, or Vercel:
   - Enable **Automated sanitized error reports** only and confirm the preference persisted.
   - `chmod -R a-w "$P_DEV_HOME/.harness"` for the same runtime user as the launcher.
   - Prove a direct write by that user fails (for example `touch "$P_DEV_HOME/.harness/.write-test"` → `EACCES`).
   - From Configure, submit a **normal preference write** (not **Reset local telemetry identity**) that keeps `errorReportingPreference: enabled`, does not enable analytics, and requires persistence—for example toggling `disclosureShown` through the real Configure session with the observability nonce.
   - Expected capture: `configure_request_error` / `configure_route` via preferences route `handleObservabilityRouteFailure` when preference persistence fails (for example when `.harness` is read-only).
   - **Do not use Reset local telemetry identity** as the trigger; reset disables observability transports before attempting the write.
6. Keep the launcher running through consent-withdrawal validation below; do not stop after the first event.
7. Inspect **raw stored event JSON** in Sentry:
   - no `user`, `user.geo`, `ip_address`, `contexts.trace`, `trace_id`, or `span_id`
   - `package_version` equals installed tarball version
   - `release_sha` equals tarball `workspace-snapshot/manifest.json` `sourceCommit`
   - exactly one event; zero user identity in Sentry Users
8. Consent withdrawal: restore `.harness` write permissions, disable automated error reporting in Configure, make `.harness` read-only again, repeat the same preference-write failure once, and confirm the Sentry event count remains exactly one.
9. Stop the launcher cleanly so observability flush/shutdown hooks run.
10. Teardown: `unset P_DEV_SENTRY_DSN SENTRY_DSN NEXT_PUBLIC_SENTRY_DSN SENTRY_AUTH_TOKEN`, delete temp files.

Do **not** bump package version, publish npm, tag, or create a GitHub release from observability validation work alone.

### PostHog sandbox privacy revalidation (operator-run)

Use the exact-head packaged tarball with the committed public PostHog project token. Unset `P_DEV_POSTHOG_PROJECT_TOKEN`, `P_DEV_POSTHOG_HOST`, `POSTHOG_PROJECT_API_KEY`, `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_API_KEY`, and `NEXT_PUBLIC_POSTHOG_KEY`.

1. Fresh disposable `P_DEV_HOME` temp directory.
2. Install and launch the packed tarball with `npx p-dev-harness@VERSION --no-open`.
3. Confirm zero PostHog traffic before analytics consent.
4. Enable **Anonymous product analytics** only in Configure.
5. Confirm exactly one `p_dev_session_started` and one deterministic Configure view/completion event from a real non-mutating product interaction.
6. Inspect raw stored PostHog events for allowlisted properties only; confirm no person profile exists.
7. Disable analytics in Configure and confirm no new events; relaunch and confirm session-start count remains `1`.
8. Run every dashboard insight query and verify session, Configure, release-filter, and OS cards show validation data.
9. Teardown: stop launcher, delete temp `P_DEV_HOME`, unset PostHog environment variables.

## Current example — v0.4.0 (release-prep; not published until approved)

| Variable | Value |
|----------|-------|
| `VERSION` | `0.4.0` |
| `TAG` | `v0.4.0` (not created until post-merge approval) |
| `RELEASE_SHA` | merge commit on `main` after this release-prep PR |
| `TARBALL` | `packages/p-dev/p-dev-harness-0.4.0.tgz` |
| Merge PR | (this release-prep PR) |
| npm / GitHub release | **Not created** until operator approves PR + artifact checksum |

## Previous example — v0.3.1 (published 2026-07-14)

| Variable | Value |
|----------|-------|
| `VERSION` | `0.3.1` |
| `TAG` | `v0.3.1` |
| `RELEASE_SHA` | `995387c74334ba85206d9d87d7d78d4ecbfa8361` |
| `TARBALL` | `packages/p-dev/p-dev-harness-0.3.1.tgz` |
| Merge PR | https://github.com/weston-uribe/agentic-product-development-harness/pull/60 |
| npm | https://www.npmjs.com/package/p-dev-harness/v/0.3.1 |
| GitHub release | https://github.com/weston-uribe/agentic-product-development-harness/releases/tag/v0.3.1 |
| registry shasum | `d71a6f4a71a9913f51232cfcd066826c1045f36b` |

Post-release evidence PR records immutable validation fixtures and finalization merge SHA. The `v0.3.1` tag remains pinned to `RELEASE_SHA`, not the finalization merge.
