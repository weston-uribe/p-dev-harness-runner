/**
 * Settings mutation conventions (Commit B):
 *
 * 1. Load committed state on the server; never trust client-supplied committed snapshots.
 * 2. Edit a draft locally in the editor component.
 * 3. Preview remote or local writes through existing setup APIs when required.
 * 4. Require explicit confirmation before apply.
 * 5. Apply, then verify local/remote summaries and roll back UI draft on failure.
 *
 * Scoped invalidation:
 * - Credentials: local `.env.local` only (connect-services); cloud secrets unchanged unless edited separately.
 * - Linear: Linear mappings + dependent cloud config via apply-linear-setup.
 * - Vercel: bridge + webhook only via apply-vercel-bridge.
 * - Repositories: local config only; detach never deletes GitHub repos.
 * - Automation: local config patch only.
 */

export type SettingsMutationPhase =
  | "idle"
  | "previewing"
  | "preview-ready"
  | "applying"
  | "success"
  | "error";

export type SettingsMutationState<TPreview = unknown> = {
  phase: SettingsMutationPhase;
  preview: TPreview | null;
  error: string | null;
  successMessage: string | null;
};

export function initialSettingsMutationState<
  TPreview = unknown,
>(): SettingsMutationState<TPreview> {
  return {
    phase: "idle",
    preview: null,
    error: null,
    successMessage: null,
  };
}

export function sanitizeSettingsErrorMessage(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/ghp_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/lin_api_[A-Za-z0-9]+/g, "[redacted]");
}
