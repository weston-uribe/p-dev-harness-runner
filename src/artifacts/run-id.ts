export function createRunId(issueKey: string, date = new Date()): string {
  const iso = date.toISOString().replace(/[:.]/g, "-");
  return `${iso}-${issueKey}`;
}
