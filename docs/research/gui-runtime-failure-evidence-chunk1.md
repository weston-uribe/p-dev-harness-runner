# GUI Runtime Failure Evidence — Chunk 1

Captured: 2026-07-18T21:54:03Z
Git SHA: a444708804a6d0a9a2f4b6a036ae2792d0d59e99
Branch: feat/eval-pipeline

## Port 3000 owner
COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    99388 weston   19u  IPv6 0xc61af92588ee7af4      0t0  TCP [::1]:3000 (LISTEN)

## Related processes
  PID  PPID ELAPSED COMMAND
99371  1698   38:46 node /Users/weston/.nvm/versions/node/v22.21.1/bin/p-dev
99374 99373   38:45 node /Users/weston/Code/agentic-product-development-harness/node_modules/.bin/next dev --hostname localhost --port 3000
99388 99374   38:45 next-server (v15.5.20) 

## which p-dev
lrwxr-xr-x@ 1 weston  staff  72 Jul 18 09:04 /Users/weston/.nvm/versions/node/v22.21.1/bin/p-dev -> ../lib/node_modules/agentic-product-development-harness/bin/p-dev-dev.js

## BUILD_ID
B3NxEiNBV3xgYSDDjQ_Ir
## Timestamps
Jul 18 14:20:00 2026 apps/gui/.next/BUILD_ID
Jul 18 14:22:58 2026 apps/gui/.next/server/webpack-runtime.js

## Chunk 8819
-rw-r--r--@ 1 weston  staff  138463 Jul 18 14:19 apps/gui/.next/server/chunks/8819.js

## webpack-runtime require of 8819

## Probe verify-saved-connections
status=500 content_type=text/html; charset=utf-8
<!DOCTYPE html><html><head><meta charSet="utf-8" data-next-head=""/><meta name="viewport" content="width=device-width" data-next-head=""/><style data-next-hide-fouc="true">body{display:none}</style><noscript data-next-hide-fouc="true"><style>body{display:block}</style></noscript><noscript data-n-css=""></noscript><script defer="" noModule="" src="/_next/static/chunks/polyfills.js"></script><script src="/_next/static/chunks/webpack.js" defer=""></script><script src="/_next/static/chunks/main.js" 

## Probe GET /
status=307 redirect=http://localhost:3000/settings/connections?repair=vercel

## Analysis at capture time

- Source-linked `p-dev` was serving via **`next dev`** (mutable `apps/gui/.next`).
- `POST /api/setup/verify-saved-connections` returned **HTTP 500** with **`text/html`** (Next error page), not JSON credential health. This is a **local runtime / module-loading failure**, not proof that Vercel/Linear credentials are invalid.
- `GET /` → **307** to `/settings/connections?repair=vercel` is expected workspace routing (durable Vercel recovery state `needs_scope` was present) and is independent of the missing-chunk class of failure.
- Chunk `8819.js` was present again at capture time after later recompiles; the original operator report referenced a missing `./8819.js` from `webpack-runtime.js`. Timestamp skew (`BUILD_ID` earlier than `webpack-runtime.js`) shows the mutable cache was rewritten while the server was alive.

## Controlled reproduction (for Chunk 1 validation)

1. Launch operator mode (`p-dev` / `npm start`) against an atomically published runtime.
2. After ready, delete or rename one referenced server chunk under that runtime’s validated `distDir`.
3. Expect integrity check / API probe to fail as recoverable generated-output mismatch.
4. Confirm one bounded rebuild/recovery; confirm incomplete staging dirs without completion manifests are never reused.
