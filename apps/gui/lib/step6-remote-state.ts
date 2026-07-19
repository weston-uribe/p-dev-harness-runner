import type { RemoteSetupSummary } from "@harness/setup/remote-setup-summary";

export interface Step6RemoteStateRevisionTracker {
  current: number;
}

export function createStep6RemoteStateRevisionTracker(): Step6RemoteStateRevisionTracker {
  return { current: 0 };
}

export function beginStep6RemoteStateRevision(
  tracker: Step6RemoteStateRevisionTracker,
): number {
  tracker.current += 1;
  return tracker.current;
}

export function isLatestStep6RemoteStateRevision(
  tracker: Step6RemoteStateRevisionTracker,
  revision: number,
): boolean {
  return revision === tracker.current;
}

export function shouldInstallStep6RemoteSummary(input: {
  tracker: Step6RemoteStateRevisionTracker;
  revision: number;
}): boolean {
  return isLatestStep6RemoteStateRevision(input.tracker, input.revision);
}

export function installStep6RemoteSummaryIfLatest(input: {
  tracker: Step6RemoteStateRevisionTracker;
  revision: number;
  summary: RemoteSetupSummary;
  install: (summary: RemoteSetupSummary) => void;
}): boolean {
  if (!shouldInstallStep6RemoteSummary(input)) {
    return false;
  }
  input.install(input.summary);
  return true;
}
