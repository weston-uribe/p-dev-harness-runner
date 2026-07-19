/** Fresh implementation_start markers block duplicate dispatches. */
export const IMPLEMENTATION_IN_PROGRESS_STALE_MS = 15 * 60 * 1000;

export function parseRunIdTimestamp(runId: string): Date | null {
  const match = runId.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/,
  );
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`);
}

export function isImplementationStartStale(
  runId: string,
  nowMs: number = Date.now(),
): boolean {
  const startedAt = parseRunIdTimestamp(runId);
  if (!startedAt) {
    return true;
  }

  return nowMs - startedAt.getTime() > IMPLEMENTATION_IN_PROGRESS_STALE_MS;
}
