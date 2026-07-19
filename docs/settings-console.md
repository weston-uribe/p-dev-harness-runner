# Settings console

The post-setup Settings console lives under `apps/gui/app/settings/(console)/`. The route group keeps the setup wizard (`/settings/configure`) outside the permanent sidebar layout.

## Current scope (v0.4)

The simplified Settings console provides:

- **Connections** as the default landing route (`/settings` redirects here)
- **Linear**, **Target repositories**, **Deployments**, **Models**, and **Data and privacy**
- **Models** — same save queue and rollback behavior as `/workflow`

Mutation editors for credentials, Linear, Vercel, and target repositories are implemented under `apps/gui/components/settings/editors/`. They call the same setup APIs as the wizard but use the settings mutation flow documented in `apps/gui/lib/settings/settings-mutation.ts`.

The **Target repositories** page includes a read-only status block for each configured repo: harness `previewProvider` from local config (separate from the PDev automation bridge), and `initializationStatus` from `.p-dev/product.json` on each repo's development branch when `GITHUB_TOKEN` is configured.

Local config-only edits (repositories) use `src/setup/settings-config-patch.ts` with fingerprint CAS via `/api/settings/preview-config-patch` and `/api/settings/apply-config-patch`.

## Future multi-connection model

Today the harness supports a **single active Linear connection** and **single active Vercel connection**. Future versions may introduce explicit connection collections without changing current URLs:

```ts
linearConnections: LinearConnection[];
vercelConnections: VercelConnection[];
targetRepos: {
  linearConnectionId?: string;
  vercelConnectionId?: string;
  // ...
}[];
```

Commit A/B types remain limited to the single-connection model actually implemented. There is no "Add another workspace/account" UI in v0.4.

## Routing rules

| Concern | Rule |
|---------|------|
| Workspace maturity | Local durable evidence only (`classifyWorkspaceEntry`) — no live Vercel API on `GET /` |
| New (first-run) | `/settings/configure` (Initial Harness Configuration) |
| Established + missing/unhealthy durable bridge | `/settings/connections?repair=vercel` |
| Established + verified durable bridge | `/workflow` |
| Settings access | Established workspaces may always enter Settings; first-run still redirects to Configure |
| Credential health | Live verify after Connections loads (Missing / Checking → Connected / Unauthorized / Unable to verify) |

A revoked Vercel token alone does not force repair routing when a previously verified bridge remains in durable control-plane evidence. Workflow may open with a connection-health warning linking to Connections repair.

Separate models: workspace maturity, Vercel credential health, and PDev bridge health — do not collapse them.
