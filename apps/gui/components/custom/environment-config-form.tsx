"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { FORM } from "@/lib/constants";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/custom/status-badge";
import { ServiceIcon } from "@/components/custom/service-icons";
import { ConnectedStatusMessage } from "@/components/custom/connected-status";
import {
  isServiceFailedForValue,
  isServiceVerifiedForValue,
  resolveServiceConnectionBadgeState,
} from "@/lib/verification-state";
import { cn } from "@/lib/utils";
import {
  GITHUB_TOKEN_GUIDED_HELPER_TEXT,
  GITHUB_TOKEN_INPUT_LABEL,
} from "@harness/setup/github-workflow-permissions";
import { GitHubTokenHelpDisclosure } from "@/components/custom/github-token-help-disclosure";

export interface EnvironmentFormValues {
  harnessConfigPath: string;
  githubDispatchRepository: string;
  linearApiKey: string;
  cursorApiKey: string;
  githubToken: string;
  vercelToken: string;
}

export interface EnvironmentFormPresence {
  LINEAR_API_KEY: boolean;
  CURSOR_API_KEY: boolean;
  GITHUB_TOKEN: boolean;
  VERCEL_TOKEN: boolean;
}

export type ServiceKey = keyof EnvironmentFormPresence;

export type VerificationUiState =
  | "unchecked"
  | "missing"
  | "checking"
  | "connected"
  | "unauthorized"
  | "unknown"
  | "failed";

export interface ServiceVerificationUi {
  state: VerificationUiState;
  verifiedValueFingerprint?: string;
  attemptedValueFingerprint?: string;
  message?: string;
  limitation?: string;
  label?: string;
}

export type ServiceVerificationMap = Record<ServiceKey, ServiceVerificationUi>;

export const INITIAL_SERVICE_VERIFICATION: ServiceVerificationMap = {
  LINEAR_API_KEY: { state: "unchecked" },
  CURSOR_API_KEY: { state: "unchecked" },
  GITHUB_TOKEN: { state: "unchecked" },
  VERCEL_TOKEN: { state: "unchecked" },
};

interface EnvironmentConfigFormProps {
  values: EnvironmentFormValues;
  presence: EnvironmentFormPresence;
  highlightDispatchRepo?: boolean;
  variant?: "guided-services" | "advanced";
  verification?: ServiceVerificationMap;
  verifyingKey?: ServiceKey | null;
  emphasizeKey?: ServiceKey | null;
  verifyButtonLabel?: (key: ServiceKey) => string;
  helperTextOverride?: Partial<Record<ServiceKey, string>>;
  expandedContent?: Partial<Record<ServiceKey, ReactNode>>;
  onChange: (values: EnvironmentFormValues) => void;
  onVerifyService?: (key: ServiceKey) => void;
  onServiceBlur?: (key: ServiceKey) => void;
}

const SERVICE_DEFINITIONS: Array<{
  key: ServiceKey;
  id: string;
  displayName: string;
  valueKey: keyof Pick<
    EnvironmentFormValues,
    "linearApiKey" | "cursorApiKey" | "githubToken" | "vercelToken"
  >;
  helperText: string;
  inputLabel?: string;
}> = [
  {
    key: "LINEAR_API_KEY",
    id: "linear-api-key",
    displayName: "Linear",
    valueKey: "linearApiKey",
    helperText: "Lets the harness read and update Linear issues.",
    inputLabel: "Copy an existing Linear API key or create a new one, then paste it here.",
  },
  {
    key: "CURSOR_API_KEY",
    id: "cursor-api-key",
    displayName: "Cursor",
    valueKey: "cursorApiKey",
    helperText:
      "Used to spin up Cursor agents that do the planning and development work.",
    inputLabel: "Copy an existing Cursor API key or create a new one, then paste it here.",
  },
  {
    key: "GITHUB_TOKEN",
    id: "github-token",
    displayName: "GitHub",
    valueKey: "githubToken",
    helperText: GITHUB_TOKEN_GUIDED_HELPER_TEXT,
    inputLabel: GITHUB_TOKEN_INPUT_LABEL,
  },
  {
    key: "VERCEL_TOKEN",
    id: "vercel-token",
    displayName: "Vercel",
    valueKey: "vercelToken",
    helperText:
      "Used to configure the PDev automation bridge hosted on Vercel (not target-app preview deployment).",
    inputLabel: "Copy an existing Vercel token or create a new one, then paste it here.",
  },
];

function verificationBadge(state: VerificationUiState) {
  switch (state) {
    case "checking":
      return { label: "Checking", variant: "secondary" as const };
    case "connected":
      return { label: "Connected", variant: "success" as const };
    case "unauthorized":
      return { label: "Unauthorized", variant: "destructive" as const };
    case "unknown":
      return { label: "Unable to verify", variant: "secondary" as const };
    case "missing":
      return { label: "Missing", variant: "secondary" as const };
    case "failed":
      return { label: "Failed", variant: "destructive" as const };
    default:
      return { label: "Missing", variant: "secondary" as const };
  }
}


export function EnvironmentConfigForm({
  values,
  presence,
  highlightDispatchRepo = false,
  variant = "advanced",
  verification = INITIAL_SERVICE_VERIFICATION,
  verifyingKey = null,
  emphasizeKey = null,
  verifyButtonLabel,
  helperTextOverride,
  expandedContent,
  onChange,
  onVerifyService,
  onServiceBlur,
}: EnvironmentConfigFormProps) {
  const update = (patch: Partial<EnvironmentFormValues>) => {
    onChange({ ...values, ...patch });
  };

  if (variant === "guided-services") {
    const ordered = emphasizeKey
      ? [
          ...SERVICE_DEFINITIONS.filter((service) => service.key === emphasizeKey),
          ...SERVICE_DEFINITIONS.filter((service) => service.key !== emphasizeKey),
        ]
      : SERVICE_DEFINITIONS;
    return (
      <div className="space-y-4">
        {ordered.map((service) => (
          <ServiceConnectionCard
            key={service.key}
            id={service.id}
            serviceKey={service.key}
            displayName={service.displayName}
            helperText={
              helperTextOverride?.[service.key] ?? service.helperText
            }
            inputLabel={service.inputLabel}
            present={presence[service.key]}
            value={values[service.valueKey]}
            verification={verification[service.key]}
            verifying={verifyingKey === service.key}
            emphasized={emphasizeKey === service.key}
            verifyLabel={verifyButtonLabel?.(service.key)}
            autoFocus={emphasizeKey === service.key}
            expandedContent={expandedContent?.[service.key]}
            onChange={(value) => update({ [service.valueKey]: value })}
            onVerify={
              onVerifyService ? () => onVerifyService(service.key) : undefined
            }
            onBlur={
              onServiceBlur ? () => onServiceBlur(service.key) : undefined
            }
          />
        ))}
      </div>
    );
  }

  return (
    <div className={FORM.fieldGrid}>
      <div className={FORM.fieldStack}>
        <Label htmlFor="harness-config-path">HARNESS_CONFIG_PATH</Label>
        <Input
          id="harness-config-path"
          value={values.harnessConfigPath}
          onChange={(event) =>
            update({ harnessConfigPath: event.target.value })
          }
          autoComplete="off"
        />
        <p className={FORM.secretHint}>
          Recommended: .harness/config.local.json
        </p>
      </div>

      <div className={FORM.fieldStack}>
        <Label htmlFor="github-dispatch-repository">
          GITHUB_DISPATCH_REPOSITORY
        </Label>
        <Input
          id="github-dispatch-repository"
          value={values.githubDispatchRepository}
          onChange={(event) =>
            update({ githubDispatchRepository: event.target.value })
          }
          autoComplete="off"
          className={highlightDispatchRepo ? "border-destructive/60" : undefined}
        />
        <p className={FORM.secretHint}>
          Harness repo used for remote setup checks and Actions secret writes.
          {highlightDispatchRepo
            ? " This value still points at an old disposable smoke-test repo."
            : " Defaults to git remote origin when unset."}
        </p>
      </div>

      {SERVICE_DEFINITIONS.map((service) => (
        <SecretField
          key={service.key}
          id={service.id}
          label={service.key}
          present={presence[service.key]}
          value={values[service.valueKey]}
          onChange={(value) => update({ [service.valueKey]: value })}
        />
      ))}
    </div>
  );
}

function ServiceConnectionCard({
  id,
  serviceKey,
  displayName,
  helperText,
  inputLabel,
  present,
  value,
  verification,
  verifying,
  emphasized = false,
  verifyLabel,
  autoFocus = false,
  expandedContent,
  onChange,
  onVerify,
  onBlur,
}: {
  id: string;
  serviceKey: ServiceKey;
  displayName: string;
  helperText: string;
  inputLabel?: string;
  present: boolean;
  value: string;
  verification: ServiceVerificationUi;
  verifying: boolean;
  emphasized?: boolean;
  verifyLabel?: string;
  autoFocus?: boolean;
  expandedContent?: ReactNode;
  onChange: (value: string) => void;
  onVerify?: () => void;
  onBlur?: () => void;
}) {
  const prefersReducedMotion = useReducedMotion() ?? false;
  const badgeState = resolveServiceConnectionBadgeState(
    present,
    verification,
    value,
  );
  const badge = verificationBadge(badgeState);
  const trimmedValue = value.trim();
  const verifiedForCurrentValue =
    verification.state === "connected" &&
    (trimmedValue
      ? isServiceVerifiedForValue(verification, trimmedValue)
      : present);
  const failedForCurrentValue =
    (verification.state === "failed" ||
      verification.state === "unauthorized" ||
      verification.state === "unknown") &&
    (trimmedValue
      ? isServiceFailedForValue(verification, trimmedValue) ||
        verification.attemptedValueFingerprint === undefined
      : present);
  const showConnectedMessage =
    verifiedForCurrentValue && Boolean(verification.message);
  const showFailedMessage = failedForCurrentValue && Boolean(verification.message);

  const resolveVerifyButtonLabel = verifying
    ? "Verifying and saving…"
    : verifiedForCurrentValue
      ? "Verified"
      : (verifyLabel ?? "Verify and save");

  const verifyButtonDisabled =
    verifying ||
    verifiedForCurrentValue ||
    (!trimmedValue && !present);

  return (
    <motion.div
      layout={!prefersReducedMotion}
      className={
        emphasized
          ? "rounded-lg border-2 border-amber-500/70 bg-card p-4 space-y-3 ring-2 ring-amber-500/20"
          : "rounded-lg border border-border bg-card p-4 space-y-3"
      }
      data-emphasized={emphasized ? "true" : undefined}
      data-service-key={serviceKey}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <p className="inline-flex items-center gap-2 text-sm font-medium">
            <ServiceIcon serviceKey={serviceKey} />
            <span>{displayName}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label={badge.label} variant={badge.variant} />
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{helperText}</p>

      <div className={FORM.fieldStack}>
        <Label htmlFor={id}>{inputLabel ?? serviceKey}</Label>
        <Input
          id={id}
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          placeholder={
            present ? "Leave blank to keep existing value" : "Enter value"
          }
          autoComplete="off"
          autoFocus={autoFocus}
        />
      </div>

      {serviceKey === "GITHUB_TOKEN" ? <GitHubTokenHelpDisclosure /> : null}

      <div className="flex flex-col items-start gap-2">
        {showConnectedMessage ? (
          <ConnectedStatusMessage message={verification.message!} />
        ) : showFailedMessage ? (
          <ConnectedStatusMessage message={verification.message!} failed />
        ) : present &&
          (verification.state === "unchecked" ||
            verification.state === "checking") &&
          !trimmedValue ? (
          <p className="text-sm text-muted-foreground">
            A credential is already saved. Checking whether it still works…
          </p>
        ) : null}

        {verification.limitation &&
        (verifiedForCurrentValue || failedForCurrentValue) ? (
          <p className="text-xs text-muted-foreground">
            {verification.limitation}
          </p>
        ) : null}

        {onVerify ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onVerify}
            disabled={verifyButtonDisabled}
          >
            {resolveVerifyButtonLabel}
          </Button>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {expandedContent ? (
          <motion.div
            key={`${serviceKey}-expanded`}
            initial={
              prefersReducedMotion ? false : { height: 0, opacity: 0 }
            }
            animate={{ height: "auto", opacity: 1 }}
            exit={
              prefersReducedMotion
                ? undefined
                : { height: 0, opacity: 0 }
            }
            transition={
              prefersReducedMotion
                ? { duration: 0 }
                : { duration: 0.28, ease: [0.2, 0, 0, 1] }
            }
            className="overflow-hidden"
            data-expanded-content={serviceKey}
          >
            {expandedContent}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

function SecretField({
  id,
  label,
  present,
  value,
  helperText,
  onChange,
}: {
  id: string;
  label: string;
  present: boolean;
  value: string;
  helperText?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={FORM.fieldStack}>
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        <StatusBadge
          label={present ? "Set" : "Not configured yet"}
          variant={present ? "success" : "secondary"}
        />
      </div>
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={present ? "Leave blank to keep existing value" : "Enter value"}
        autoComplete="off"
      />
      {helperText ? (
        <p className={FORM.secretHint}>{helperText}</p>
      ) : present ? (
        <p className={FORM.secretHint}>
          Existing values are never shown. Leave blank to preserve a set key.
        </p>
      ) : null}
    </div>
  );
}
