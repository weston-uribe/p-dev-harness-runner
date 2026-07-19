"use client";

import { FORM } from "@/lib/constants";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/custom/status-badge";
import type {
  HarnessActionsSecretName,
  HarnessSecretStatusEntry,
} from "@harness/setup/remote-actions";

export interface RemoteSecretFormValues {
  linearApiKey: string;
  cursorApiKey: string;
  harnessGithubToken: string;
}

interface RemoteSecretFormProps {
  values: RemoteSecretFormValues;
  secretStatuses: HarnessSecretStatusEntry[];
  onChange: (values: RemoteSecretFormValues) => void;
}

const SECRET_LABELS: Record<HarnessActionsSecretName, string> = {
  HARNESS_CONFIG_JSON_B64: "HARNESS_CONFIG_JSON_B64",
  LINEAR_API_KEY: "LINEAR_API_KEY",
  CURSOR_API_KEY: "CURSOR_API_KEY",
  HARNESS_GITHUB_TOKEN: "HARNESS_GITHUB_TOKEN",
};

function statusVariant(
  status: HarnessSecretStatusEntry["status"],
): "success" | "warning" | "secondary" {
  if (status === "present") return "success";
  if (status === "missing") return "warning";
  return "secondary";
}

export function RemoteSecretForm({
  values,
  secretStatuses,
  onChange,
}: RemoteSecretFormProps) {
  const update = (patch: Partial<RemoteSecretFormValues>) => {
    onChange({ ...values, ...patch });
  };

  const statusByName = new Map(
    secretStatuses.map((entry) => [entry.name, entry.status]),
  );

  return (
    <div className={FORM.fieldGrid}>
      <div className={FORM.fieldStack}>
        <Label>HARNESS_CONFIG_JSON_B64</Label>
        <p className="text-sm text-muted-foreground">
          Generated server-side from validated `.harness/config.local.json` during
          apply. Never shown in previews or responses.
        </p>
        <StatusBadge
          label={statusByName.get("HARNESS_CONFIG_JSON_B64") ?? "unknown"}
          variant={statusVariant(statusByName.get("HARNESS_CONFIG_JSON_B64") ?? "unknown")}
        />
      </div>

      <RemoteSecretField
        id="remote-linear-api-key"
        label={SECRET_LABELS.LINEAR_API_KEY}
        status={statusByName.get("LINEAR_API_KEY") ?? "unknown"}
        value={values.linearApiKey}
        onChange={(linearApiKey) => update({ linearApiKey })}
      />
      <RemoteSecretField
        id="remote-cursor-api-key"
        label={SECRET_LABELS.CURSOR_API_KEY}
        status={statusByName.get("CURSOR_API_KEY") ?? "unknown"}
        value={values.cursorApiKey}
        onChange={(cursorApiKey) => update({ cursorApiKey })}
      />
      <RemoteSecretField
        id="remote-harness-github-token"
        label={SECRET_LABELS.HARNESS_GITHUB_TOKEN}
        status={statusByName.get("HARNESS_GITHUB_TOKEN") ?? "unknown"}
        value={values.harnessGithubToken}
        onChange={(harnessGithubToken) => update({ harnessGithubToken })}
      />
    </div>
  );
}

function RemoteSecretField({
  id,
  label,
  status,
  value,
  onChange,
}: {
  id: string;
  label: string;
  status: HarnessSecretStatusEntry["status"];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={FORM.fieldStack}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <StatusBadge label={status} variant={statusVariant(status)} />
      </div>
      <Input
        id={id}
        type="password"
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      <p className={FORM.secretHint}>
        Existing GitHub Actions secret values are never readable. Leave blank to
        preserve an existing secret when status is present.
      </p>
    </div>
  );
}
