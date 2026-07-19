export function resolveRunGeneration(env: Record<string, string | undefined> = process.env): number {
  const explicit = env.HARNESS_RUN_GENERATION;
  if (explicit && /^\d+$/.test(explicit)) {
    return Number(explicit);
  }

  const receivedAt = env.RECEIVED_AT;
  if (receivedAt) {
    const parsed = Date.parse(receivedAt);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  const githubRunId = env.GITHUB_RUN_ID;
  if (githubRunId && /^\d+$/.test(githubRunId)) {
    return Number(githubRunId);
  }

  return Date.now();
}
