import { describe, expect, it } from "vitest";
import {
  isNonAuthoritativeLinearWorkspaceName,
  pickDisplayedLinearWorkspaceName,
  resolveAuthoritativeLinearWorkspaceIdentity,
} from "../../src/setup/linear-workspace-identity.js";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("linear workspace identity", () => {
  it("treats known placeholders as non-authoritative", () => {
    expect(isNonAuthoritativeLinearWorkspaceName("Linear workspace")).toBe(true);
    expect(
      isNonAuthoritativeLinearWorkspaceName("Workspace name unavailable"),
    ).toBe(true);
    expect(isNonAuthoritativeLinearWorkspaceName("")).toBe(true);
    expect(isNonAuthoritativeLinearWorkspaceName("Weston Product Lab")).toBe(
      false,
    );
  });

  it("prefers a live renamed organization over a valid older durable name", () => {
    const identity = resolveAuthoritativeLinearWorkspaceIdentity({
      liveOrganization: {
        id: "ws-live",
        name: "Renamed Product Lab",
      },
      liveLookupFailed: false,
      durableWorkspaceId: "ws-old",
      durableWorkspaceName: "Old Plausible Name",
      configWorkspaceId: "ws-old",
    });
    expect(identity.source).toBe("live");
    expect(identity.workspaceName).toBe("Renamed Product Lab");
    expect(identity.workspaceId).toBe("ws-live");
  });

  it("falls back to durable only when live lookup fails", () => {
    const identity = resolveAuthoritativeLinearWorkspaceIdentity({
      liveOrganization: null,
      liveLookupFailed: true,
      durableWorkspaceId: "ws-1",
      durableWorkspaceName: "Durable Real Name",
    });
    expect(identity.source).toBe("durable");
    expect(identity.workspaceName).toBe("Durable Real Name");
  });

  it("does not fall back to a durable placeholder when live lookup fails", () => {
    const identity = resolveAuthoritativeLinearWorkspaceIdentity({
      liveLookupFailed: true,
      durableWorkspaceName: "Linear workspace",
      durableWorkspaceId: "ws-1",
    });
    expect(identity.source).toBe("unavailable");
    expect(identity.workspaceName).toBe("Workspace name unavailable");
  });

  it("treats an empty live organization name as unavailable", () => {
    const identity = resolveAuthoritativeLinearWorkspaceIdentity({
      liveOrganization: { id: "ws-1", name: "" },
      liveLookupFailed: false,
      durableWorkspaceName: "Durable Real Name",
    });
    expect(identity.source).toBe("unavailable");
    expect(identity.workspaceName).toBe("Workspace name unavailable");
  });

  it("lets bootstrap/live display names outrank health-snapshot placeholders", () => {
    expect(
      pickDisplayedLinearWorkspaceName({
        bootstrapName: "Live Org",
        healthName: "Linear workspace",
      }),
    ).toBe("Live Org");
    expect(
      pickDisplayedLinearWorkspaceName({
        bootstrapName: "Linear workspace",
        healthName: "Durable Real Name",
      }),
    ).toBe("Durable Real Name");
  });

  it("removes the manufactured Linear workspace fallback from org summary", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/setup/linear-setup-client.ts"),
      "utf8",
    );
    expect(source).toContain('name: organization.name?.trim() || ""');
    expect(source).not.toContain(
      'name: organization.name?.trim() || "Linear workspace"',
    );
  });
});
