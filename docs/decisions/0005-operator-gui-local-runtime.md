# ADR 0005: Operator GUI local runtime (immutable production build)

**Status:** Accepted  
**Date:** 2026-07-18  
**Evidence:** [`docs/research/gui-runtime-failure-evidence-chunk1.md`](../research/gui-runtime-failure-evidence-chunk1.md)

## Decision

1. **Operator mode** (`p-dev`, `npm start`) serves the GUI with **`next build` + `next start`** from an **atomically published**, snapshot-keyed runtime under `apps/gui/.p-dev-runtime/`.
2. **Developer mode** (`npm run dev`, `npm run gui:dev`) continues to use **`next dev`** with the mutable default `apps/gui/.next`.
3. Modes are never silently substituted. A command named `dev` must not produce production-build operator behavior.
4. Retain **Next.js** for both modes. Do not migrate to Electron/Tauri/another framework because generated output became corrupt.
5. Operator builds use a **snapshot-scoped lock**, unique **staging** directories, **validation + completion manifest**, then **atomic promotion**. Incomplete or interrupted builds are never reusable.
6. Browser open happens only after a full **runtime integrity** check (HTML/CSS/JS/API/identity/process), not HTTP 200 alone.

## Context

Source-linked `p-dev` previously launched `next dev`. Operators observed recurring failures such as:

```text
Error: Cannot find module './8819.js'
Require stack: .../apps/gui/.next/server/webpack-runtime.js
page: '/api/setup/verify-saved-connections'
```

Symptoms included API `500`s (often HTML error pages), unstyled Settings, broken dropdowns/hydration, and misleading connection warnings. Prior recovery only wiped `apps/gui/.next` after a CSS-only health check, which did not detect missing server chunks or prevent mutable-cache races.

`GET /` returning `307` to Configure/Workflow/Connections is expected routing and is independent of the missing-chunk defect.

## Options considered

| Option | Summary | Outcome |
|--------|---------|---------|
| A. Keep `next dev` as operator runtime | Hot reload for operators | **Rejected** — mutable/partial `.next` cannot meet reliability or identity requirements |
| B. Local production server + atomic publication | `next build`/`next start`, snapshot-keyed, staged promote | **Chosen** |
| C. Next.js standalone as primary | Packaged standalone server | **Rejected for now** — extra packaging surface; revisit for single-binary distribution |
| D. Desktop wrapper / framework migration | Electron, Tauri, etc. | **Rejected** — defect is runtime publication, not framework choice |

## Chosen design

- Snapshot identity from source (git HEAD and/or content fingerprint).
- Build into `.p-dev-runtime/.building-<snapshot>-<pid>` under a bounded lock.
- Validate `BUILD_ID`, manifests, server entrypoints, static assets, and snapshot identity.
- Write completion manifest only after validation; atomically promote to `.p-dev-runtime/<snapshot>`.
- Concurrent same-snapshot launches reuse the completed runtime or wait for the active build.
- One bounded recovery: stop owned child, delete owned completed runtime, rebuild once.
- Connection verification distinguishes `local_runtime_error` from credential/bridge failures.

## Consequences

### Positive

- Operator runtime is immutable for a given snapshot identity.
- Developer hot reload remains available via conventional `dev` commands.
- Interrupted builds cannot be mistaken for healthy runtimes.
- Integrity failures produce actionable diagnostics instead of a broken browser session.

### Negative / costs

- First operator launch per snapshot pays a production build cost.
- Two runtimes can coexist (`.next` for dev, `.p-dev-runtime/*` for operator); disk use increases.

## Revisit when

- Offline single-binary distribution requires standalone output (option C).
- Operator UX requires a true desktop shell unrelated to Next reliability (option D).
- Next.js provides a first-class immutable local operator profile that supersedes this staging model.
