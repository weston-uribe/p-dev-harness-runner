# Observability and privacy

This document is the canonical contract for optional, consent-gated observability in the published `p-dev-harness` npm package.

## Purpose

Packaged observability helps the maintainer understand onboarding reliability and Configure funnel outcomes without collecting source code, credentials, prompts, or account identity.

Telemetry is **evidence, not authoritative**. Never trigger releases, security actions, or Linear issues solely from Sentry or PostHog data.

## Consent model

Two independent categories:

1. **Anonymous product analytics** (PostHog)
2. **Automated sanitized error reports** (Sentry)

Defaults:

- No network transmission until the user chooses for each category.
- Consent changes are local preferences only and do **not** emit analytics events.
- Environment kill switches override persisted preferences without mutating them:
  - `DO_NOT_TRACK=1`
  - `P_DEV_OBSERVABILITY_DISABLED=1`
  - `P_DEV_ANALYTICS_DISABLED=1`
  - `P_DEV_SENTRY_DISABLED=1`

Local state path: `.harness/observability.local.json` under the resolved `P_DEV_HOME`.

## Identity

| Field | PostHog | Sentry |
|-------|---------|--------|
| Session ID (ephemeral) | yes | yes |
| Installation ID (stable per `P_DEV_HOME`) | yes (`distinct_id`) | **no** |
| Package version / release SHA | yes | yes (release/tags) |

The installation ID is generated only when analytics is first enabled.

## Runtime boundary

Observability runs only in packaged `p-dev` runtime (`P_DEV_RUNTIME_MODE=packaged`). It is disabled in source development, tests, CI, package preparation, snapshot generation, and other non-packaged contexts unless tests inject fake transports.

## Public vendor configuration

Tracked source file: `config/observability.public.json`

Package copy: `observability.public.json`

Contains only:

- Sentry public DSN
- PostHog project token
- PostHog ingestion host
- Observability schema version

Maintainer-only overrides (not required for end users):

- `P_DEV_SENTRY_DSN`
- `P_DEV_POSTHOG_PROJECT_TOKEN`
- `P_DEV_POSTHOG_HOST`
- `P_DEV_SENTRY_ENVIRONMENT`

Never ship Sentry auth tokens, PostHog personal API keys (`phx_`), or organization-management credentials.

## PostHog event contract (schema version 1)

Allowed events:

- `p_dev_session_started`
- `p_dev_configure_step_viewed`
- `p_dev_configure_step_completed`
- `p_dev_workspace_provision_started`
- `p_dev_workspace_provision_completed`
- `p_dev_workspace_provision_failed`
- `p_dev_setup_completed`
- `p_dev_model_fast_toggle_displayed`
- `p_dev_model_fast_preference_changed`
- `p_dev_model_agent_run_started`
- `p_dev_model_agent_run_completed`

Model events may include only bounded properties: `agent_role`, `base_model_id`,
`fast_enabled`, `capability_source`, `configuration_surface`,
`parameter_evidence_source`, and `outcome` (for run completed). No prompts,
outputs, code, credentials, or Linear content.

Consent preference events are intentionally excluded.

All analytics events set `$process_person_profile: false`.

## Sentry context contract (schema version 1)

Allowed tags/context include package/release metadata, ephemeral session ID, lifecycle phase, structured product error codes, bounded buckets, and sanitized exception data.

Sentry fingerprints use structured product error code and lifecycle phase only (not package version).

## Sentry outbound privacy boundary

The Sentry adapter builds allowlisted error events and sends them through an isolated `NodeClient` using `sendEvent()`, bypassing default SDK scope merge and tracing integrations.

### Client envelope guarantees

Automated envelope tests prove the structured outbound payload omits:

- `user`, `request`, `breadcrumbs`, `transaction`, `server_name`, `contexts`
- `ip_address`, `trace_id`, `span_id`, `parent_span_id`, installation ID
- tracing/profiling client options (rates are omitted entirely, not set to `0`)
- envelope-header `trace` metadata

Allowed content is limited to approved product error messages, sanitized exception metadata, allowlisted tags, package/release metadata, ephemeral session ID, and fingerprints based on product error code plus lifecycle phase.

Production enforcement is best-effort: if a final outbound event or envelope cannot be scrubbed into compliance, the adapter **drops** it and continues harness execution. Automated tests **throw** on the same violations.

### Vendor-derived metadata (not client fields)

Sentry may derive metadata during HTTP ingestion that does not appear in the client-built event JSON:

- **Geography** under User in the Sentry UI is commonly derived from the ingestion request IP, not from a `user` field sent by this harness.
- **Trace Details / Trace Preview** in the Sentry UI may appear even when the client envelope contains no trace context. Inspect the raw stored event JSON; do not treat UI chrome alone as proof of client transmission.

Official Sentry server-side scrubbing documents that geographic information can be extracted from IP even when "Prevent storing IP addresses" is enabled. Removing stored geo requires an Advanced Data Scrubbing rule.

### Mandatory Sentry project settings (release gate)

Before enabling a public DSN in `config/observability.public.json`, verify the target Sentry project (`kinterra/p-dev-harness`, US ingestion region) has all of the following settings and that live sandbox raw-event evidence matches them.

**Required privacy settings**

- Data Scrubber: enabled
- Default Scrubbers: enabled
- Prevent Storing IP Addresses: enabled
- Advanced Data Scrubbing: `[Remove] [Anything] from [$user.geo.**]`
- Advanced Data Scrubbing: `[Remove] [Anything] from [contexts.trace]`

**Required disabled capabilities**

Keep these disabled unless repository evidence explicitly requires otherwise:

- tracing / performance monitoring
- profiling
- replay
- logs
- metrics
- AI monitoring
- automatic HTTP instrumentation
- automatic console instrumentation
- source-map uploading
- JavaScript source fetching
- SCM source context

**Other expected settings**

- TLS verification enabled
- Spike Protection enabled
- Auto Resolve disabled
- no user-identifying integrations enabled

**Packaged credential boundary**

- The public DSN is packaged in `config/observability.public.json` and copied into the npm tarball.
- Sentry auth tokens, organization-management tokens, and source-map upload credentials must never be packaged.
- Sentry capture starts only after affirmative error-reporting consent; consent withdrawal must stop subsequent capture.

**Vendor UI vs stored fields**

- Sentry may show trace-related issue UI even when stored `contexts.trace` has been scrubbed.
- Raw stored event JSON and authoritative Discover fields are the release gate; do not treat UI chrome alone as proof of client transmission.

Release remains blocked until:

- automated envelope tests pass in CI
- sandbox raw event JSON shows no `user`, `user.geo`, `ip_address`, or `contexts.trace`
- the project settings above are verified on the target Sentry project
- source maps, JavaScript source fetching, and SCM source context remain disabled

## Dashboard: p-dev Packaged Onboarding Health

**Status:** implemented in PostHog project `p-dev-harness` (US region, `https://us.i.posthog.com`).

Machine-readable contract: [`src/observability/posthog-dashboard-contract.ts`](../src/observability/posthog-dashboard-contract.ts)

Dashboard identity:

- **Name:** `p-dev Packaged Onboarding Health`
- **Default date range:** last 30 days
- **Dashboard filters:** `package_version`, `release_sha`, `os_family`

Mandatory cards:

1. Interpretation (Markdown)
2. Packaged Sessions by Release (`p_dev_session_started` by `package_version`)
3. Packaged Sessions by OS (`p_dev_session_started` by `os_family`)
4. Session to Setup Completion (`p_dev_session_started` → `p_dev_setup_completed`)
5. Configure Step Completion Funnel (all eight `p_dev_configure_step_completed` steps with `completion_outcome` in `success` / `skipped_already_complete`, or the authorized split funnels Steps 1–4 and Steps 5–8)
6. Configure Outcomes by Step (`step_id` × `completion_outcome`)
7. Workspace Provisioning Outcomes (started / completed / failed trends)
8. Provisioning Failure Categories (`failure_category`)
9. Provisioning Duration Buckets (`duration_bucket`)
10. Provisioning Retry Buckets (`retry_count_bucket`)
11. Rate-Limit Pause Buckets (`rate_limit_pause_count_bucket`)

PostHog project privacy settings (defense in depth):

- Discard client IP data: enabled
- GeoIP enrichment: disabled
- Person profiles: disabled (`$process_person_profile: false` on every event)
- Server-only transport (no browser SDK, autocapture, session replay, or web analytics)

Public packaged configuration:

- Organization: `Kinterra`
- Project: `p-dev-harness`
- Public project ingestion token is packaged in `config/observability.public.json` and mirrored to `packages/p-dev/observability.public.json`
- Personal API keys (`phx_`), MCP credentials, and organization-management credentials are forbidden in tracked files and tarballs

Do not build consent-rate metrics; affirmative consent makes non-consenting installs intentionally invisible.

Reconstruction procedure: use PostHog MCP (`dashboard-create`, `insight-create`, `dashboard-create-text-tile`) with query definitions from `posthog-dashboard-contract.ts`. Validate saved dashboard and insight definitions against the repository contract before merge.

## PostHog release validation

Before an observability-enabled npm release:

- Verify legacy `Default Project` deletion and clean `p-dev-harness` project creation
- Verify packaged public PostHog token (not `phx_`) and unchanged Sentry public DSN
- Verify no pre-consent telemetry in packaged smoke tests
- Verify tarball includes public config and excludes local observability state
- Verify live packaged validation sequence `0 / 1 / 1` for `p_dev_session_started`
- Verify stored PostHog events satisfy the privacy allowlist and create no person profile
- Verify dashboard insight queries execute against validation data
- Run `tests/observability/posthog-dashboard-contract.test.ts`

## Sentry alerts (minimal)

- New unhandled error in latest package
- Regression of resolved issue
- High-frequency provisioning error
- Launch / Configure API crash
- Error rate increase by release version

## Reset

Delete `.harness/observability.local.json` to clear local data-sharing preferences and telemetry identity. Configure no longer exposes a reset control; use **Settings → Data sharing** to change preferences after onboarding.

## Release validation

Before an observability-enabled npm release:

- Verify no pre-consent telemetry in packaged smoke tests
- Verify tarball includes public config and excludes local observability state
- Verify sandbox Sentry/PostHog payloads match allowlists
- Compare funnel/error metrics by `package_version` after fixes
- Verify automated Sentry envelope privacy tests pass
- Verify sandbox raw event JSON and mandatory Sentry project privacy settings before authorizing a public DSN

Do not claim legal compliance in this document.
