import type { Step6AutomaticApplyOutcomeKind } from "./first-run-readiness.js";

export interface Step6AutomaticControlStateInput {
  setupType: "automatic" | "manual" | null;
  confirmed: boolean;
  loading: string | null;
  remoteActionsBlocked: boolean;
  remoteActionsBlockedReason?: string;
  previewValidationError?: string | null;
  automaticOutcomeKind: Step6AutomaticApplyOutcomeKind;
  cloudSecretsPreviewOpened: boolean;
  remoteSecretPreviewStale: boolean;
}

export interface Step6AutomaticControlState {
  confirmDisabled: boolean;
  confirmDisabledReason?: string;
  applyDisabled: boolean;
  applyDisabledReason?: string;
  stalePreviewBlockerActive: boolean;
}

export function deriveStep6AutomaticControlState(
  input: Step6AutomaticControlStateInput,
): Step6AutomaticControlState {
  const confirmDisabled =
    input.remoteActionsBlocked || Boolean(input.previewValidationError);
  const confirmDisabledReason = input.remoteActionsBlocked
    ? input.remoteActionsBlockedReason
    : input.previewValidationError
      ? "Fix validation errors before confirming this write."
      : undefined;

  const applyDisabled =
    input.loading !== null ||
    !input.confirmed ||
    Boolean(input.previewValidationError) ||
    input.remoteActionsBlocked ||
    input.automaticOutcomeKind === "success";

  const applyDisabledReason =
    confirmDisabledReason ??
    (!input.confirmed
      ? "Confirm the GitHub Actions secret write before applying."
      : input.automaticOutcomeKind === "success"
        ? "Automatic secret write already verified for the current config."
        : undefined);

  const stalePreviewBlockerActive =
    input.remoteSecretPreviewStale && input.cloudSecretsPreviewOpened;

  return {
    confirmDisabled,
    confirmDisabledReason,
    applyDisabled,
    applyDisabledReason,
    stalePreviewBlockerActive,
  };
}
