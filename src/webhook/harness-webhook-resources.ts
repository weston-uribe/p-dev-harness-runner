/** Linear resource types required for harness auto-run + revision reconciliation. */
export const HARNESS_WEBHOOK_RESOURCE_TYPES = ["Issue", "Comment"] as const;

export type HarnessWebhookResourceType =
  (typeof HARNESS_WEBHOOK_RESOURCE_TYPES)[number];

export function webhookHasHarnessResourceTypes(
  resourceTypes: string[] | null | undefined,
): boolean {
  const set = new Set((resourceTypes ?? []).map((value) => value.trim()));
  return HARNESS_WEBHOOK_RESOURCE_TYPES.every((required) => set.has(required));
}
