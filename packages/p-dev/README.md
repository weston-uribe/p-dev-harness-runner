# p-dev-harness

Launch the **Product Development Harness** guided Configure GUI without cloning the source repository.

Published on npm as **`p-dev-harness`** today. The package manifest also declares a **`p-dev`** bin alias for a future release; `p-dev-harness@0.4.0` does not expose `p-dev` on npm yet.

## Quick start

**Node.js 22+** required.

```bash
npx --yes p-dev-harness@0.4.0
```

PDev automatically opens Initial Harness Configuration until setup is complete, then opens the Workflow page.

Without browser auto-open:

```bash
npx --yes p-dev-harness@0.4.0 --no-open
```

Custom workspace:

```bash
npx --yes p-dev-harness@0.4.0 --workspace ~/.p-dev
```

## What it does

- Starts the seven-step Configure GUI at `/settings/configure`
- Stores durable operator state under `~/.p-dev`, `P_DEV_HOME`, or `--workspace`
- Provisions fresh private `OWNER/p-dev-harness` workspaces from the **immutable embedded workspace snapshot** shipped inside the exact npm package you install
- Reconnects valid existing managed workspaces, including legacy `p-dev-harness@0.3.0` template-provisioned workspaces
- Guides Linear, Cursor, GitHub, and Vercel setup through confirmation-gated remote writes

## Provisioning model (0.3.1+)

Each published `p-dev-harness@X.Y.Z` tarball contains `workspace-snapshot/manifest.json` plus curated snapshot files. Fresh private workspaces are created with GitHub git object APIs from that embedded snapshot. The package does **not** read `weston-uribe/p-dev-harness-template` at runtime.

**First-time workspace provisioning can take several minutes** while snapshot blobs upload. Progress is shown in the Configure UI. If GitHub rate-limits the upload, the harness pauses and retries automatically — you do not need to set environment variables for the default path.

Advanced override (optional): `HARNESS_SNAPSHOT_UPLOAD_CONCURRENCY` — integer `1`–`4` only; default is `2`.

## Requirements

- Classic GitHub PAT with **`repo`** + **`workflow`** scopes for packaged workspace provisioning
- Linear, Cursor, and Vercel credentials for full setup

The public template repository `weston-uribe/p-dev-harness-template` is a **frozen legacy compatibility artifact for `p-dev-harness@0.3.0` only**. It is not required for 0.3.1+ fresh provisioning.

## Limitations

- Cursor-only agent provider; Linear/GitHub/GitHub Actions/Vercel stack
- macOS validated for browser auto-launch; use `--no-open` elsewhere
- Existing managed workspaces are **not** upgraded automatically in the background — use **Settings → Deployments → Update PDev runner** for an operator-initiated snapshot upgrade (conflict-safe three-way replace + GitHub Actions config canary)
- Setup completion is validated; a full real issue lifecycle from an isolated npm install is **not** yet validated
- Early-stage operator tool — not production SaaS

## Optional telemetry (consent-gated)

Configure shows a first-run **Data sharing** screen before guided setup. The same unified choice can be edited later from **Settings → Data sharing**. Nothing is transmitted until you opt in; disabling the choice keeps both analytics and sanitized error reports off.

Disable globally with `DO_NOT_TRACK=1` or `P_DEV_OBSERVABILITY_DISABLED=1`. Delete `.harness/observability.local.json` to reset local preferences and identity.

Details: [`docs/observability-and-privacy.md`](https://github.com/weston-uribe/agentic-product-development-harness/blob/main/docs/observability-and-privacy.md)

## Full guide

See the repository guide: [docs/p-dev.md](https://github.com/weston-uribe/agentic-product-development-harness/blob/main/docs/p-dev.md)

## License

MIT
