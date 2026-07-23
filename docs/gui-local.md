# Local GUI

Launch the Product Development Harness GUI for guided setup and workflow operations.

## Operator mode (stable)

Use these commands for the durable operator-facing runtime (`next build` + `next start` from an atomically published snapshot-keyed runtime):

```bash
p-dev
# or, from the source repository:
npm start
```

From anywhere after `npm run p-dev:install` in the source checkout:

```bash
p-dev
```

PDev opens Initial Harness Configuration until setup is complete, then opens the Workflow page (or Connections repair when durable Vercel recovery requires it).

The browser opens only after runtime integrity checks pass (HTML/CSS/JS, setup APIs, source/workspace/build identity).

## Developer mode (hot reload)

Use conventional `dev` commands for mutable hot-reload development (`next dev`, `apps/gui/.next`):

```bash
npm run dev
# alias:
npm run gui:dev
```

Do **not** use developer mode as the operator runtime. Do **not** expect `npm run dev` to perform production builds.

## Useful flags

```bash
p-dev --workspace ~/.p-dev
p-dev --no-open
p-dev --port 3000 --host localhost
```

## Diagnostics

```bash
npm run harness:gui:doctor
```

Reports safe hashes, paths, process listeners, and whether a completed operator runtime exists for the current snapshot. Never prints secrets.

Architecture decision: [`docs/decisions/0005-operator-gui-local-runtime.md`](decisions/0005-operator-gui-local-runtime.md).

## Compatibility scripts (deprecated)

These still delegate to the **operator** launcher but print a deprecation notice:

- `npm run harness:gui`
- `npm run harness:configure`
- `npm run harness:configure:stable`

Prefer `p-dev` or `npm start` for operators.

## Cursor usage import

Operator bulk CSV → Langfuse score enrichment lives at **Settings → Cursor usage**.
See [`docs/evaluation/cursor-usage-import-operator.md`](evaluation/cursor-usage-import-operator.md).
Browser E2E: `npm run test:cursor-usage:browser` (not covered by `npm test`).

## Troubleshooting

If the GUI is unstyled, Settings navigation is broken, or connection verification returns HTML/`500`, treat it as a **local runtime** problem first — not invalid Linear/Vercel credentials.

Operator recovery rebuilds the snapshot-keyed runtime once (staging → validate → atomic promote). Developer mode may clean `apps/gui/.next` once after a styling health failure.

For GitHub Codespaces and remote port forwarding, see [`docs/gui-remote-setup.md`](gui-remote-setup.md).

## Restore published package command

To switch back from a source-linked `p-dev` to the published package:

```bash
npm unlink -g agentic-product-development-harness
npx --yes p-dev-harness@0.4.0
```
