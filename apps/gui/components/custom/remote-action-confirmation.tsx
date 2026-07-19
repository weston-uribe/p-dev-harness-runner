"use client";

import { FORM } from "@/lib/constants";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

type RemoteConfirmationScope =
  | "remote-secret-write"
  | "vercel-bridge-write"
  | "remote-repo-write"
  | "linear-write";
type RemoteConfirmationVariant = "advanced" | "guided";

interface RemoteActionConfirmationProps {
  scope: RemoteConfirmationScope;
  confirmed: boolean;
  disabled?: boolean;
  disabledReason?: string;
  variant?: RemoteConfirmationVariant;
  onConfirmedChange: (confirmed: boolean) => void;
}

const COPY: Record<
  RemoteConfirmationScope,
  {
    advanced: { title: string; bullets: string[]; label: string };
    guided: { title: string; bullets: string[]; label: string };
  }
> = {
  "remote-secret-write": {
    advanced: {
      title: "Confirm harness repo Actions secret writes",
      bullets: [
        "Writes encrypted GitHub Actions secrets to the harness dispatch repo only.",
        "HARNESS_CONFIG_JSON_B64 is generated server-side from local config.",
        "Secret values are never returned in previews, results, or errors.",
        "No target repo branches, PRs, Linear writes, or harness phases will run.",
      ],
      label:
        "I reviewed the harness secret preview and want to write these Actions secrets.",
    },
    guided: {
      title: "Confirm cloud secrets write",
      bullets: [
        "This writes encrypted GitHub Actions secrets to the harness repo.",
        "Preflight runs automatically before apply when you skip preview.",
        "It does not run the harness, create branches, open PRs, or change your target app.",
        "Secret values are never shown in previews, results, or errors.",
      ],
      label:
        "I understand this will create or update encrypted GitHub Actions secrets in the harness repo.",
    },
  },
  "vercel-bridge-write": {
    advanced: {
      title: "Confirm Vercel deployment settings",
      bullets: [
        "May save the selected Vercel account/team and project for this harness.",
        "May configure required application-preview or deployment settings.",
        "Verifies the resulting Vercel connection after apply.",
        "PDev does not delete the Vercel project or production deployment unless that deletion is explicitly supported and separately confirmed.",
      ],
      label:
        "I understand PDev will save the selected Vercel team and project, configure required deployment settings, and verify the connection. PDev will not delete the Vercel project or production deployment unless separately confirmed.",
    },
    guided: {
      title: "Confirm Vercel settings write",
      bullets: [
        "This may create or update Vercel production environment variables and configure the Linear webhook bridge.",
        "It does not run the harness, create branches, open PRs, or change your target app.",
        "Secret values are never shown in previews, results, or errors.",
      ],
      label:
        "I understand this will write Vercel environment variables and configure the Linear webhook bridge.",
    },
  },
  "remote-repo-write": {
    advanced: {
      title: "Confirm target workflow branch and PR install",
      bullets: [
        "Creates or updates an install branch and opens or reuses a PR.",
        "Never writes directly to the target repo production or main branch.",
        "No harness repo secret writes, Linear writes, or harness phases will run.",
      ],
      label:
        "I reviewed the workflow preview and want to create or update the install PR.",
    },
    guided: {
      title: "Confirm workflow install PR",
      bullets: [
        "This may create or update an install branch and open or reuse a PR.",
        "Preflight runs automatically before apply when you skip preview.",
        "It does not merge the PR, write directly to main/production, run the harness, or write Linear.",
      ],
      label:
        "I understand this will create or update the workflow install PR in the target repo.",
    },
  },
  "linear-write": {
    advanced: {
      title: "Confirm Linear workspace writes",
      bullets: [
        "May create or repair required workflow statuses for the selected teams.",
        "Saves team and project connections and updates required Linear project metadata.",
        "Detaching a project may remove only the PDev-managed metadata block when no associations remain.",
        "PDev will not delete Linear teams, projects, issues, or statuses.",
      ],
      label:
        "I understand PDev will create or repair the required workflow statuses for the selected teams, save these team and project connections, and update the Linear project metadata required by the harness. PDev will not delete Linear teams, projects, issues, or statuses.",
    },
    guided: {
      title: "Confirm Linear workspace setup",
      bullets: [
        "This may create missing Linear workflow statuses or workspace resources.",
        "It does not run harness automation or modify your target app repo.",
      ],
      label:
        "I understand this will apply Linear workspace setup changes.",
    },
  },
};

export function RemoteActionConfirmation({
  scope,
  confirmed,
  disabled = false,
  disabledReason,
  variant = "advanced",
  onConfirmedChange,
}: RemoteActionConfirmationProps) {
  const copy = COPY[scope][variant];

  return (
    <div className={FORM.confirmationBox}>
      <p className="text-sm font-medium">{copy.title}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {copy.bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
      <div className="flex items-start gap-3">
        <Checkbox
          id={`confirm-${scope}`}
          checked={confirmed}
          disabled={disabled}
          onChange={(event) => onConfirmedChange(event.target.checked)}
        />
        <Label htmlFor={`confirm-${scope}`} className="text-sm leading-snug">
          {copy.label}
        </Label>
      </div>
      {disabled && disabledReason ? (
        <p className="text-sm text-muted-foreground">{disabledReason}</p>
      ) : null}
    </div>
  );
}
