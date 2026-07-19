import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/setup/vercel-setup-client.js", () => ({
  listVercelTeams: vi.fn(),
  listVercelProjects: vi.fn(),
}));

vi.mock("../../src/setup/github-dispatch-token.js", () => ({
  assessGitHubDispatchTokenEligibility: vi.fn(),
}));

import { assessGitHubDispatchTokenEligibility } from "../../src/setup/github-dispatch-token.js";
import {
  listVercelProjects,
  listVercelTeams,
} from "../../src/setup/vercel-setup-client.js";
import { loadVercelBridgeOptions } from "../../src/setup/vercel-bridge-options.js";

describe("vercel-bridge-options", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "vercel-bridge-options-"));
    await mkdir(path.join(tempRoot, ".harness"), { recursive: true });
    vi.mocked(listVercelTeams).mockResolvedValue([
      { id: "team-1", name: "Acme", slug: "acme" },
    ]);
    vi.mocked(listVercelProjects).mockResolvedValue([
      { id: "proj-1", name: "harness-gui", accountId: "acct-1" },
    ]);
    vi.mocked(assessGitHubDispatchTokenEligibility).mockResolvedValue({
      eligible: true,
      source: "saved-github-token",
      repository: "owner/harness",
      message: "Saved GITHUB_TOKEN can dispatch to owner/harness.",
    });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns an error when VERCEL_TOKEN is missing", async () => {
    const result = await loadVercelBridgeOptions({
      vercelToken: "",
      cwd: tempRoot,
    });

    expect(result.loadError).toMatch(/VERCEL_TOKEN is required/i);
    expect(result.scopes).toEqual([]);
    expect(result.projects).toEqual([]);
  });

  it("includes personal scope, team scopes, and capabilities from Vercel teams API", async () => {
    const result = await loadVercelBridgeOptions({
      vercelToken: "vercel-token",
      cwd: tempRoot,
    });

    expect(result.scopes).toEqual([
      { id: "", label: "Personal account (no team)", kind: "personal" },
      { id: "team-1", label: "Acme (acme)", kind: "team" },
    ]);
    expect(result.capabilities).toEqual({
      teamCreate: true,
      projectCreate: true,
    });
    expect(result.githubDispatch.eligible).toBe(true);
    expect(listVercelProjects).toHaveBeenCalledWith("vercel-token", undefined);
  });

  it("loads team-scoped projects when a team scope is selected", async () => {
    await loadVercelBridgeOptions({
      vercelToken: "vercel-token",
      teamId: "team-1",
      cwd: tempRoot,
    });

    expect(listVercelProjects).toHaveBeenCalledWith("vercel-token", "team-1");
  });

  it("auto-selects a single project option", async () => {
    const result = await loadVercelBridgeOptions({
      vercelToken: "vercel-token",
      cwd: tempRoot,
    });

    expect(result.selectedProjectId).toBe("proj-1");
  });

  it("derives harnessTeamKey from control-plane Linear state", async () => {
    await writeFile(
      path.join(tempRoot, ".harness/control-plane-setup.json"),
      JSON.stringify({
        version: 1,
        linear: { teamKey: "WES" },
      }),
      "utf8",
    );

    const result = await loadVercelBridgeOptions({
      vercelToken: "vercel-token",
      cwd: tempRoot,
    });

    expect(result.harnessTeamKey).toBe("WES");
  });

  it("prefers persisted Vercel scope and project when still valid", async () => {
    vi.mocked(listVercelProjects).mockResolvedValue([
      { id: "proj-1", name: "harness-gui", accountId: "acct-1" },
      { id: "proj-2", name: "other-project", accountId: "acct-1" },
    ]);
    await writeFile(
      path.join(tempRoot, ".harness/control-plane-setup.json"),
      JSON.stringify({
        version: 1,
        vercel: { teamId: "team-1", projectId: "proj-2" },
      }),
      "utf8",
    );

    const result = await loadVercelBridgeOptions({
      vercelToken: "vercel-token",
      cwd: tempRoot,
    });

    expect(result.selectedScopeId).toBe("team-1");
    expect(result.selectedProjectId).toBe("proj-2");
  });
});
