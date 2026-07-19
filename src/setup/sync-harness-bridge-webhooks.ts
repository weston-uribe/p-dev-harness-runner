import {
  createLinearSetupClient,
  listLinearWebhooks,
  updateLinearIssueWebhook,
  type LinearWebhookSummary,
} from "./linear-setup-client.js";
import { webhookHasHarnessResourceTypes } from "../webhook/harness-webhook-resources.js";

function normalizeWebhookUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export interface SyncHarnessBridgeWebhooksResult {
  matched: number;
  updated: number;
  webhookIds: string[];
  skipped: Array<{ webhookId: string; reason: string }>;
}

/**
 * Align every Linear webhook that targets the harness bridge URL:
 * - shared signing secret (must match Vercel LINEAR_WEBHOOK_SECRET)
 * - Issue + Comment resource types
 *
 * Multi-team workspaces create one webhook per team; rotating only one team
 * strands the others with invalid_signature (FRE-3 Needs Revision silence).
 */
export async function syncHarnessBridgeWebhooks(input: {
  linearApiKey: string;
  webhookUrl: string;
  secret: string;
}): Promise<SyncHarnessBridgeWebhooksResult> {
  const canonicalUrl = normalizeWebhookUrl(input.webhookUrl);
  const secret = input.secret.trim();
  if (!canonicalUrl || !secret) {
    throw new Error("webhookUrl and secret are required");
  }

  const client = createLinearSetupClient(input.linearApiKey);
  const webhooks = await listLinearWebhooks(client);
  const matches = webhooks.filter(
    (webhook) => normalizeWebhookUrl(webhook.url) === canonicalUrl,
  );

  const updated: string[] = [];
  const skipped: Array<{ webhookId: string; reason: string }> = [];

  for (const webhook of matches) {
    const needsSecret =
      !webhook.secret || webhook.secret.trim() !== secret;
    const needsResources = !webhookHasHarnessResourceTypes(webhook.resourceTypes);
    if (!needsSecret && !needsResources && webhook.enabled) {
      skipped.push({ webhookId: webhook.id, reason: "already_synced" });
      continue;
    }

    await updateLinearIssueWebhook(client, {
      webhookId: webhook.id,
      url: canonicalUrl,
      secret,
      label: webhook.url ? undefined : "Harness webhook bridge",
    });
    updated.push(webhook.id);
  }

  return {
    matched: matches.length,
    updated: updated.length,
    webhookIds: updated,
    skipped,
  };
}

export function findBridgeWebhooksForUrl(
  webhooks: LinearWebhookSummary[],
  webhookUrl: string,
): LinearWebhookSummary[] {
  const canonicalUrl = normalizeWebhookUrl(webhookUrl);
  return webhooks.filter(
    (webhook) => normalizeWebhookUrl(webhook.url) === canonicalUrl,
  );
}
