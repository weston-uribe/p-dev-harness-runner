import { describe, expect, it } from "vitest";
import {
  beginStep6RemoteStateRevision,
  createStep6RemoteStateRevisionTracker,
  installStep6RemoteSummaryIfLatest,
} from "../../apps/gui/lib/step6-remote-state.js";
import type { RemoteSetupSummary } from "../../src/setup/remote-setup-summary.js";

function sampleSummary(overrides: Partial<RemoteSetupSummary> = {}): RemoteSetupSummary {
  return {
    githubTokenConfigured: true,
    harnessDispatchRepo: "weston-uribe/p-dev-harness",
    harnessDispatchRepoResolved: true,
    harnessDispatchRepoSource: "explicit-config",
    harnessRepoAccess: "available",
    requireVercelProductionToken: false,
    harnessSecretStatuses: [],
    targetRepos: [],
    staleSmokeDiagnostics: {
      hasStaleConfig: false,
      findings: [],
      staleTargetRepos: [],
    },
    ...overrides,
  };
}

describe("step6 remote state revision", () => {
  it("installs only the latest remote summary revision", () => {
    const tracker = createStep6RemoteStateRevisionTracker();
    const installed: RemoteSetupSummary[] = [];

    const staleRevision = beginStep6RemoteStateRevision(tracker);
    const latestRevision = beginStep6RemoteStateRevision(tracker);

    installStep6RemoteSummaryIfLatest({
      tracker,
      revision: latestRevision,
      summary: sampleSummary({ harnessRepoAccess: "available" }),
      install: (summary) => installed.push(summary),
    });
    installStep6RemoteSummaryIfLatest({
      tracker,
      revision: staleRevision,
      summary: sampleSummary({ harnessRepoAccess: "denied" }),
      install: (summary) => installed.push(summary),
    });

    expect(installed).toHaveLength(1);
    expect(installed[0]?.harnessRepoAccess).toBe("available");
  });

  it("allows a later refresh revision to replace an earlier installed summary", () => {
    const tracker = createStep6RemoteStateRevisionTracker();
    const installed: RemoteSetupSummary[] = [];

    const firstRevision = beginStep6RemoteStateRevision(tracker);
    installStep6RemoteSummaryIfLatest({
      tracker,
      revision: firstRevision,
      summary: sampleSummary({ harnessDispatchRepoResolved: false }),
      install: (summary) => installed.push(summary),
    });

    const secondRevision = beginStep6RemoteStateRevision(tracker);
    installStep6RemoteSummaryIfLatest({
      tracker,
      revision: secondRevision,
      summary: sampleSummary({ harnessDispatchRepoResolved: true }),
      install: (summary) => installed.push(summary),
    });

    expect(installed).toHaveLength(2);
    expect(installed.at(-1)?.harnessDispatchRepoResolved).toBe(true);
  });
});
