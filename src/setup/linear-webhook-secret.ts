import { randomBytes } from "node:crypto";
import {
  createLinearIssueWebhook,
  createLinearSetupClient,
  listLinearWebhooks,
  updateLinearIssueWebhook,
  type LinearWebhookSummary,
} from "./linear-setup-client.js";
import { summarizeLinearWebhookReadiness } from "./linear-setup-plan.js";

export type LinearWebhookSecretMode =
  | "automated"
  | "existing-unverified"
  | "manual-copy";

export type LinearWebhookCandidateSource =
  | "operator"
  | "reused-readable"
  | "generated"
  | "unreadable";

export type LinearWebhookMutatePolicy =
  | "setup"
  | "verify-only"
  | "verify-reconcile-url";

export interface LinearWebhookUrlReconciliationResult {
  attempted: boolean;
  reconciled: boolean;
  previousWebhookId?: string;
  previousWebhookUrl?: string;
  canonicalWebhookExists: boolean;
  matchingPreviousWebhookFound: boolean;
  manualSteps: string[];
}

export interface LinearWebhookSecretPlan {
  mode: LinearWebhookSecretMode;
  secret?: string;
  matchingWebhook?: LinearWebhookSummary;
  manualSteps: string[];
  willGenerateOnApply?: boolean;
}

export interface LinearWebhookCandidateResolution {
  secret?: string;
  source: LinearWebhookCandidateSource;
  matchingWebhook?: LinearWebhookSummary;
  manualSteps: string[];
}

export function generateLinearWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

function normalizeWebhookUrl(url: string): string {
  return url.trim().replace(/\/$/, "");
}

export function findMatchingLinearWebhook(input: {
  webhooks: LinearWebhookSummary[];
  webhookUrl: string;
  linearTeamId?: string;
}): LinearWebhookSummary | undefined {
  const normalizedTarget = normalizeWebhookUrl(input.webhookUrl);
  return input.webhooks.find((webhook) => {
    const normalized = normalizeWebhookUrl(webhook.url);
    const teamMatches = input.linearTeamId
      ? webhook.teamId === input.linearTeamId
      : true;
    return (
      teamMatches &&
      normalized === normalizedTarget &&
      webhook.enabled &&
      webhook.resourceTypes.includes("Issue")
    );
  });
}

export async function resolveLinearWebhookCandidateSecret(input: {
  linearApiKey?: string;
  webhookUrl: string;
  linearTeamId?: string;
  operatorSecret?: string;
}): Promise<LinearWebhookCandidateResolution> {
  const operatorSecret = input.operatorSecret?.trim();
  if (operatorSecret) {
    return {
      secret: operatorSecret,
      source: "operator",
      manualSteps: [],
    };
  }

  if (!input.linearApiKey?.trim()) {
    return {
      source: "generated",
      manualSteps: [
        "Add LINEAR_API_KEY in Step 1 before automated Linear webhook setup can run.",
        "A webhook signing secret will be generated during apply and shown once if manual copy is required.",
      ],
    };
  }

  const client = createLinearSetupClient(input.linearApiKey);
  const webhooks = await listLinearWebhooks(client);
  const matchingWebhook = findMatchingLinearWebhook({
    webhooks,
    webhookUrl: input.webhookUrl,
    linearTeamId: input.linearTeamId,
  });

  if (matchingWebhook) {
    const knownSecret = matchingWebhook.secret?.trim();
    if (knownSecret) {
      return {
        secret: knownSecret,
        source: "reused-readable",
        matchingWebhook: { ...matchingWebhook, secret: undefined },
        manualSteps: [
          "A matching Linear Issue webhook exists. Apply will reuse its known signing secret for verification.",
        ],
      };
    }

    return {
      source: "unreadable",
      matchingWebhook: { ...matchingWebhook, secret: undefined },
      manualSteps: [
        "A matching Linear Issue webhook exists, but its signing secret cannot be read from the Linear API.",
        "Update the Linear webhook signing secret manually to match Vercel LINEAR_WEBHOOK_SECRET, then retry verification.",
        "Apply will not rotate the webhook repeatedly while the secret remains unreadable.",
      ],
    };
  }

  return {
    secret: generateLinearWebhookSecret(),
    source: "generated",
    manualSteps: [
      "Apply will create a Linear Issue webhook and write the signing secret to Vercel.",
    ],
  };
}

export async function planLinearWebhookSecret(input: {
  linearApiKey?: string;
  webhookUrl: string;
  linearTeamId?: string;
}): Promise<LinearWebhookSecretPlan> {
  if (!input.linearApiKey?.trim()) {
    return {
      mode: "manual-copy",
      manualSteps: [
        "Add LINEAR_API_KEY in Step 1 before automated Linear webhook setup can run.",
        "A webhook signing secret will be generated during apply and shown once if manual copy is required.",
      ],
    };
  }

  const readiness = await summarizeLinearWebhookReadiness({
    linearApiKey: input.linearApiKey,
    webhookUrl: input.webhookUrl,
    teamId: input.linearTeamId,
  });

  if (readiness.matchingWebhook) {
    const knownSecret = readiness.matchingWebhook.secret?.trim();
    if (knownSecret) {
      return {
        mode: "automated",
        matchingWebhook: readiness.matchingWebhook,
        willGenerateOnApply: false,
        manualSteps: [
          "A matching Linear Issue webhook already exists. Apply will reuse its known signing secret for verification.",
        ],
      };
    }

    return {
      mode: "existing-unverified",
      matchingWebhook: readiness.matchingWebhook,
      willGenerateOnApply: true,
      manualSteps: [
        "A matching Linear Issue webhook already exists, but its signing secret cannot be recovered.",
        "Apply will attempt to rotate the existing webhook secret automatically once. If that fails, copy the generated secret into Linear manually.",
      ],
    };
  }

  return {
    mode: "automated",
    willGenerateOnApply: true,
    manualSteps: [
      "Apply will create a Linear Issue webhook and write the signing secret to Vercel.",
    ],
  };
}

export async function reconcileLinearWebhookUrlForVerification(input: {
  linearApiKey: string;
  linearTeamId?: string;
  previousWebhookUrl: string;
  canonicalWebhookUrl: string;
  secret: string;
}): Promise<LinearWebhookUrlReconciliationResult> {
  const previousUrl = normalizeWebhookUrl(input.previousWebhookUrl);
  const canonicalUrl = normalizeWebhookUrl(input.canonicalWebhookUrl);

  if (!previousUrl || !canonicalUrl || previousUrl === canonicalUrl) {
    return {
      attempted: false,
      reconciled: false,
      canonicalWebhookExists: false,
      matchingPreviousWebhookFound: false,
      manualSteps: [],
    };
  }

  const client = createLinearSetupClient(input.linearApiKey);
  const webhooks = await listLinearWebhooks(client);
  const previousWebhook = findMatchingLinearWebhook({
    webhooks,
    webhookUrl: previousUrl,
    linearTeamId: input.linearTeamId,
  });
  const canonicalWebhook = findMatchingLinearWebhook({
    webhooks,
    webhookUrl: canonicalUrl,
    linearTeamId: input.linearTeamId,
  });

  if (!previousWebhook) {
    return {
      attempted: true,
      reconciled: false,
      previousWebhookUrl: previousUrl,
      canonicalWebhookExists: Boolean(canonicalWebhook),
      matchingPreviousWebhookFound: false,
      manualSteps: [
        "No matching Linear Issue webhook was found at the previously stored webhook URL.",
        "Create or update the Linear webhook manually to point at the canonical production URL, then retry verification.",
      ],
    };
  }

  if (canonicalWebhook) {
    if (canonicalWebhook.id === previousWebhook.id) {
      return {
        attempted: true,
        reconciled: true,
        previousWebhookId: previousWebhook.id,
        previousWebhookUrl: previousUrl,
        canonicalWebhookExists: true,
        matchingPreviousWebhookFound: true,
        manualSteps: [],
      };
    }

    return {
      attempted: true,
      reconciled: false,
      previousWebhookId: previousWebhook.id,
      previousWebhookUrl: previousUrl,
      canonicalWebhookExists: true,
      matchingPreviousWebhookFound: true,
      manualSteps: [
        "A separate Linear Issue webhook already exists at the canonical production URL.",
        "Consolidate webhook configuration manually before retrying verification.",
      ],
    };
  }

  try {
    await updateLinearIssueWebhook(client, {
      webhookId: previousWebhook.id,
      url: canonicalUrl,
      secret: input.secret.trim(),
    });
    return {
      attempted: true,
      reconciled: true,
      previousWebhookId: previousWebhook.id,
      previousWebhookUrl: previousUrl,
      canonicalWebhookExists: false,
      matchingPreviousWebhookFound: true,
      manualSteps: [],
    };
  } catch {
    return {
      attempted: true,
      reconciled: false,
      previousWebhookId: previousWebhook.id,
      previousWebhookUrl: previousUrl,
      canonicalWebhookExists: false,
      matchingPreviousWebhookFound: true,
      manualSteps: [
        "Could not update the existing Linear Issue webhook to the canonical production URL automatically.",
        "Update the Linear webhook URL manually to match the canonical production URL, then retry verification.",
      ],
    };
  }
}

export async function ensureLinearIssueWebhook(input: {
  linearApiKey: string;
  webhookUrl: string;
  linearTeamId?: string;
  secret: string;
  mutatePolicy?: LinearWebhookMutatePolicy;
}): Promise<{
  webhook?: LinearWebhookSummary;
  secret: string;
  mode: LinearWebhookSecretMode;
  manualSteps: string[];
}> {
  const mutatePolicy = input.mutatePolicy ?? "setup";
  const client = createLinearSetupClient(input.linearApiKey);
  const webhooks = await listLinearWebhooks(client);
  const existing = findMatchingLinearWebhook({
    webhooks,
    webhookUrl: input.webhookUrl,
    linearTeamId: input.linearTeamId,
  });

  if (existing) {
    const knownSecret = existing.secret?.trim();
    if (knownSecret === input.secret.trim()) {
      return {
        webhook: { ...existing, secret: undefined },
        secret: input.secret,
        mode: "automated",
        manualSteps: [],
      };
    }

    if (mutatePolicy === "verify-only") {
      if (knownSecret) {
        return {
          webhook: { ...existing, secret: undefined },
          secret: knownSecret,
          mode: "automated",
          manualSteps: [],
        };
      }

      return {
        webhook: { ...existing, secret: undefined },
        secret: input.secret,
        mode: "existing-unverified",
        manualSteps: [
          "Matching Linear webhook exists, but its signing secret cannot be read from the Linear API.",
          "Update the Linear webhook signing secret manually to match Vercel LINEAR_WEBHOOK_SECRET, then retry verification.",
        ],
      };
    }

    try {
      const updated = await updateLinearIssueWebhook(client, {
        webhookId: existing.id,
        url: input.webhookUrl,
        secret: input.secret,
      });
      return {
        webhook: { ...updated, secret: undefined },
        secret: input.secret,
        mode: "automated",
        manualSteps: [],
      };
    } catch {
      return {
        webhook: { ...existing, secret: undefined },
        secret: input.secret,
        mode: "existing-unverified",
        manualSteps: [
          "Matching Linear webhook exists, but its signing secret could not be rotated automatically.",
          "Copy the generated webhook secret into the Linear webhook signing secret field, then retry verification.",
        ],
      };
    }
  }

  if (mutatePolicy === "verify-only") {
    return {
      secret: input.secret,
      mode: "manual-copy",
      manualSteps: [
        `Create a Linear Issue webhook pointing at ${input.webhookUrl}.`,
        "Retry verification after the webhook exists and its signing secret matches Vercel.",
      ],
    };
  }

  if (mutatePolicy === "verify-reconcile-url") {
    return {
      secret: input.secret,
      mode: "manual-copy",
      manualSteps: [
        `Create a Linear Issue webhook pointing at ${input.webhookUrl}.`,
        "Retry verification after the webhook exists and its signing secret matches Vercel.",
      ],
    };
  }

  try {
    const created = await createLinearIssueWebhook(client, {
      url: input.webhookUrl,
      teamId: input.linearTeamId,
      label: "Harness webhook bridge",
      secret: input.secret,
    });

    if (created.secret) {
      return {
        webhook: { ...created, secret: undefined },
        secret: created.secret,
        mode: "automated",
        manualSteps: [],
      };
    }

    return {
      webhook: { ...created, secret: undefined },
      secret: input.secret,
      mode: "manual-copy",
      manualSteps: [
        "Linear webhook was created, but the signing secret was not returned by the API.",
        "Copy the generated secret into the Linear webhook signing secret field.",
      ],
    };
  } catch {
    return {
      secret: input.secret,
      mode: "manual-copy",
      manualSteps: [
        `Create a Linear Issue webhook pointing at ${input.webhookUrl}.`,
        "Copy the generated webhook secret into Linear and confirm when complete.",
      ],
    };
  }
}
