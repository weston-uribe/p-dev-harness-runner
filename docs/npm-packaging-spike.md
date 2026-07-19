# npm packaging spike (historical)

**Status:** Historical — superseded by the public `p-dev` package in v0.3.0.

The canonical end-user guide is [`docs/p-dev.md`](p-dev.md).

## What this spike proved (now shipped)

- A dedicated npm package boundary at [`packages/p-dev/`](../packages/p-dev/)
- `npx --yes p-dev-harness@0.3.0` launch without cloning the source repository
- Durable operator workspace under `P_DEV_HOME`, `--workspace`, or `~/.p-dev`
- macOS browser auto-launch for the Configure GUI
- Packaged guided setup through private harness workspace provisioning

## Maintainer tarball validation

From a clean repository checkout:

```bash
npm ci
npm run build
npm test
npm run test:webhook
npm run package:p-dev:pack
npm run package:p-dev:inspect
```

Packed tarball smoke from a clean temporary directory:

```bash
TARBALL="/absolute/path/to/repo/packages/p-dev/p-dev-harness-0.3.0.tgz"
WORKDIR=$(mktemp -d)
export P_DEV_HOME="$WORKDIR/workspace"
cd "$WORKDIR"
npx --yes "file:$TARBALL" --no-open
```

Verify the printed Configure URL responds:

```bash
curl -fsS "http://localhost:3000/settings/configure" | head
```

## Source-development path

Repo-local commands remain the contributor path:

- `npm run harness:gui`
- `npm run harness:configure`
- `npm run harness:configure:stable`

See [`docs/getting-started.md`](getting-started.md).
