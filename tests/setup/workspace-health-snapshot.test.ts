import { describe, expect, it } from "vitest";
import type { ControlPlaneSetupState } from "../../src/setup/control-plane-types.js";
import {
  deriveAutomationAttentionState,
  deriveLinearHealthFacts,
  deriveVercelHealthFacts,
  reconcileHistoricalSuccess,
  shouldAcceptHealthRefresh,
  shouldPromptRecoveryScopeSelection,
  type LinearHealthFacts,
  type VercelHealthFacts,
} from "../../src/setup/workspace-health-snapshot.js";
import { initialCredentialHealthFromPresence } from "../../src/setup/credential-health.js";

function baseState(
  overrides: Partial<ControlPlaneSetupState> = {},
): ControlPlaneSetupState {
  return {
    version: 1,
    ...overrides,
  };
}

describe("workspace health snapshot facts", () => {
  it("does not treat historical initialSetup.complete as current webhook verification", () => {
    const state = baseState({
      initialSetup: {
        status: "complete",
        completedAt: "2026-01-01T00:00:00.000Z",
        completionEvidence: {
          localConfigPresent: true,
          linearConfigured: true,
          vercelConfigured: true,
          cloudSecretsVerified: true,
          targetWorkflowsVerified: true,
        },
      },
      vercel: {
        projectId: "prj_1",
        projectName: "bridge",
        teamId: "team_weston",
        teamName: "Weston Team",
        productionUrl: "https://bridge.example.com",
        webhookUrl: "https://bridge.example.com/api/linear-webhook",
        endpointReachable: false,
        envVarPresence: {},
        linearWebhookVerified: false,
        signedProbeVerified: false,
      },
    });

    const vercel = deriveVercelHealthFacts({
      state,
      vercelCredential: initialCredentialHealthFromPresence(true),
      vercelPresent: true,
      liveCredentialVerified: false,
    });

    expect(vercel.historicalSetupComplete).toBe(true);
    expect(vercel.webhookVerified).toBe(false);
    expect(vercel.bridgeReachable).toBe(false);
    expect(vercel.automationAggregate).not.toBe("verified");
    expect(
      reconcileHistoricalSuccess({
        historicalSetupComplete: true,
        currentProbeVerified: false,
      }).showDegradedNotVerified,
    ).toBe(true);
  });

  it("does not prompt scope selection when authoritative scope is already stored", () => {
    expect(
      shouldPromptRecoveryScopeSelection({
        recoveryNeedsScope: true,
        authoritativeScope: {
          teamId: "team_weston",
          teamName: "Weston Team",
          source: "control_plane",
        },
      }),
    ).toBe(false);
    expect(
      shouldPromptRecoveryScopeSelection({
        recoveryNeedsScope: true,
        authoritativeScope: undefined,
      }),
    ).toBe(true);
  });

  it("keeps credential verification_pending without a success aggregate", () => {
    const vercel = deriveVercelHealthFacts({
      state: null,
      vercelCredential: initialCredentialHealthFromPresence(true),
      vercelPresent: true,
      liveCredentialVerified: false,
    });
    expect(vercel.credential.status).toBe("verification_pending");
    expect(vercel.credential.aggregate).toBe("verification_pending");
  });

  it("surfaces Linear workspace name and status coverage from durable evidence", () => {
    const state = baseState({
      linearWorkspace: {
        workspaceId: "ws_1",
        workspaceName: "Weston Product Lab",
        appliedAt: "2026-07-01T00:00:00.000Z",
        teams: [
          {
            teamId: "t1",
            teamKey: "WES",
            teamName: "WES",
            health: "healthy",
            projects: [
              {
                projectId: "p1",
                projectName: "App",
                health: "healthy",
              },
            ],
          },
        ],
      },
      vercel: {
        projectId: "prj_1",
        projectName: "bridge",
        productionUrl: "https://bridge.example.com",
        webhookUrl: "https://bridge.example.com/api/linear-webhook",
        endpointReachable: true,
        envVarPresence: {},
        linearWebhookVerified: true,
        signedProbeVerified: true,
        signedProbe: {
          passed: true,
          result: "accepted_ignored",
          probedAt: "2026-07-02T00:00:00.000Z",
        },
      },
    });

    const linear = deriveLinearHealthFacts({
      state,
      linearCredential: {
        status: "connected",
        label: "Weston",
        checkedAt: "2026-07-02T00:00:00.000Z",
      },
      linearPresent: true,
      liveCredentialVerified: true,
    });

    expect(linear.workspaceName).toBe("Weston Product Lab");
    expect(linear.statusConfigPresent).toBe(true);
    expect(linear.webhookVerified).toBe(true);
    expect(linear.automationAggregate).toBe("verified");
  });

  it("rejects stale health refresh when control-plane fingerprint mismatches", () => {
    expect(
      shouldAcceptHealthRefresh({
        mountedControlPlaneFingerprint: "abc",
        responseControlPlaneFingerprint: "xyz",
      }),
    ).toBe(false);
    expect(
      shouldAcceptHealthRefresh({
        mountedControlPlaneFingerprint: "abc",
        responseControlPlaneFingerprint: "abc",
      }),
    ).toBe(true);
  });
});

function stubVercel(
  automationAggregate: VercelHealthFacts["automationAggregate"],
  overrides: Partial<VercelHealthFacts> = {},
): VercelHealthFacts {
  return {
    credential: {
      present: true,
      status: "connected",
      aggregate: "verified",
    },
    bridgeDeployed: true,
    bridgeReachable: true,
    webhookConfigured: true,
    webhookVerified: automationAggregate === "verified",
    signedProbeVerified: automationAggregate === "verified",
    recovery: {
      active: automationAggregate === "repairing",
      aggregate: automationAggregate === "repairing" ? "repairing" : "missing",
      promptScopeSelection: false,
    },
    durableBridgeHealth: "verified",
    historicalSetupComplete: true,
    automationAggregate,
    ...overrides,
  };
}

function stubLinear(
  automationAggregate: LinearHealthFacts["automationAggregate"],
  overrides: Partial<LinearHealthFacts> = {},
): LinearHealthFacts {
  return {
    credential: {
      present: true,
      status: "connected",
      aggregate: "verified",
    },
    workspaceName: "Example Workspace",
    configuredTeams: [],
    statusConfigPresent: automationAggregate === "verified",
    webhookConfigured: true,
    webhookVerified: automationAggregate === "verified",
    automationAggregate,
    ...overrides,
  };
}

describe("deriveAutomationAttentionState", () => {
  it("returns null when both Linear and Vercel automation are verified", () => {
    expect(
      deriveAutomationAttentionState({
        vercel: stubVercel("verified"),
        linear: stubLinear("verified"),
      }),
    ).toBeNull();
  });

  it("warns about Linear only when Vercel is verified and Linear is pending", () => {
    const attention = deriveAutomationAttentionState({
      vercel: stubVercel("verified"),
      linear: stubLinear("verification_pending"),
    });
    expect(attention).not.toBeNull();
    expect(attention!.title).toContain("Needs verification");
    expect(attention!.title.toLowerCase()).not.toContain("verified");
    expect(attention!.facts).toHaveLength(1);
    expect(attention!.facts[0]?.subsystem).toBe("linear");
    expect(attention!.facts.some((fact) => fact.subsystem === "vercel")).toBe(
      false,
    );
  });

  it("warns about Vercel only when Linear is verified and Vercel is degraded", () => {
    const attention = deriveAutomationAttentionState({
      vercel: stubVercel("degraded"),
      linear: stubLinear("verified"),
    });
    expect(attention).not.toBeNull();
    expect(attention!.tone).toBe("degraded");
    expect(attention!.facts).toHaveLength(1);
    expect(attention!.facts[0]?.subsystem).toBe("vercel");
  });

  it("uses repairing tone when recovery is active", () => {
    const attention = deriveAutomationAttentionState({
      vercel: stubVercel("repairing"),
      linear: stubLinear("verified"),
    });
    expect(attention).not.toBeNull();
    expect(attention!.tone).toBe("repairing");
    expect(attention!.title).toContain("Repairing");
  });
});
