export function jobRequestRemotePath(requestId: string): string {
  const safeId = requestId.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  return `.p-dev/job-requests/${safeId}.json`;
}
