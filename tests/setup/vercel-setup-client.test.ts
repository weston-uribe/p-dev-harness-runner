import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

import {
  buildExistingEnvVarPatchBody,
  createVercelDeployment,
  createVercelProject,
  createVercelTeam,
  getDefaultEnvVarType,
  isDeploymentSpecificVercelHost,
  selectStableProductionHost,
  upsertVercelProjectEnvVar,
  VercelEnvVarTypeError,
  VercelTeamBillingError,
} from "../../src/setup/vercel-setup-client.js";

describe("vercel-setup-client env var upsert", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("defaults secret env vars to sensitive on create", () => {
    expect(getDefaultEnvVarType("LINEAR_WEBHOOK_SECRET")).toBe("sensitive");
    expect(getDefaultEnvVarType("GITHUB_DISPATCH_TOKEN")).toBe("sensitive");
    expect(getDefaultEnvVarType("HARNESS_TEAM_KEY")).toBe("plain");
  });

  it("builds existing env PATCH bodies without key or type", () => {
    expect(
      buildExistingEnvVarPatchBody({
        value: "ghp_saved",
        existingEnv: {
          id: "env-1",
          key: "GITHUB_DISPATCH_TOKEN",
          type: "sensitive",
          target: ["production"],
        },
      }),
    ).toEqual({
      value: "ghp_saved",
      target: ["production"],
    });
  });

  it("updates existing env vars without key or type in PATCH payload", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await upsertVercelProjectEnvVar("vercel-token", {
      projectId: "proj-1",
      key: "GITHUB_DISPATCH_TOKEN",
      value: "ghp_saved",
      existingEnv: {
        id: "env-1",
        key: "GITHUB_DISPATCH_TOKEN",
        type: "sensitive",
        target: ["production"],
      },
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      value: "ghp_saved",
      target: ["production"],
    });
  });

  it("creates env vars on the documented v10 endpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({}),
    });

    await upsertVercelProjectEnvVar("vercel-token", {
      projectId: "proj-1",
      key: "HARNESS_TEAM_KEY",
      value: "WES",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/v10/projects/proj-1/env");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      key: "HARNESS_TEAM_KEY",
      value: "WES",
      type: "plain",
      target: ["production"],
    });
  });

  it("throws a targeted error when Vercel rejects sensitive type changes", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            code: "bad_request",
            message:
              "You cannot change the type of a sensitive environment variable.",
          },
        }),
    });

    await expect(
      upsertVercelProjectEnvVar("vercel-token", {
        projectId: "proj-1",
        key: "GITHUB_DISPATCH_TOKEN",
        value: "ghp_saved",
        existingEnv: {
          id: "env-1",
          key: "GITHUB_DISPATCH_TOKEN",
          type: "sensitive",
          target: ["production"],
        },
      }),
    ).rejects.toBeInstanceOf(VercelEnvVarTypeError);
  });

  it("throws a targeted error when Vercel rejects sensitive key changes", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            code: "BAD_REQUEST",
            message:
              "You cannot change the key of a Sensitive Environment Variable.",
          },
        }),
    });

    await expect(
      upsertVercelProjectEnvVar("vercel-token", {
        projectId: "proj-1",
        key: "GITHUB_DISPATCH_TOKEN",
        value: "ghp_saved",
        existingEnv: {
          id: "env-1",
          key: "GITHUB_DISPATCH_TOKEN",
          type: "sensitive",
          target: ["production"],
        },
      }),
    ).rejects.toMatchObject({
      name: "VercelEnvVarTypeError",
      key: "GITHUB_DISPATCH_TOKEN",
    });
  });

  it("does not call DELETE when updating existing env vars", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await upsertVercelProjectEnvVar("vercel-token", {
      projectId: "proj-1",
      key: "GITHUB_DISPATCH_TOKEN",
      value: "ghp_saved",
      existingEnv: {
        id: "env-1",
        key: "GITHUB_DISPATCH_TOKEN",
        type: "sensitive",
        target: ["production"],
      },
    });

    for (const [, init] of fetchMock.mock.calls) {
      expect(String(init?.method ?? "GET")).not.toBe("DELETE");
    }
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(
      true,
    );
  });
});

describe("canonical production URL resolution", () => {
  it("detects deployment-specific vercel.app hosts", () => {
    expect(
      isDeploymentSpecificVercelHost(
        "agentic-product-development-harness-apseun4qi-kinterra-team-url.vercel.app",
      ),
    ).toBe(true);
    expect(isDeploymentSpecificVercelHost("harness-gui.vercel.app")).toBe(false);
    expect(isDeploymentSpecificVercelHost("www.example.com")).toBe(false);
  });

  it("prefers stable production alias over deployment-specific READY URL", () => {
    const selected = selectStableProductionHost({
      deploymentUrl: "agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app",
      aliases: [
        "harness-gui.vercel.app",
        "agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app",
      ],
    });

    expect(selected.source).toBe("stable_alias");
    expect(selected.host).toBe("harness-gui.vercel.app");
  });

  it("falls back to latest READY deployment URL when no stable alias exists", () => {
    const selected = selectStableProductionHost({
      deploymentUrl: "agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app",
      aliases: [
        "agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app",
      ],
    });

    expect(selected.source).toBe("latest_ready_deployment");
    expect(selected.host).toBe(
      "agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app",
    );
  });

  it("resolves canonical production target from deployment aliases", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          deployments: [
            {
              uid: "dpl-ready",
              url: "agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app",
              state: "READY",
              readyState: "READY",
              alias: ["harness-gui.vercel.app"],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          uid: "dpl-ready",
          url: "agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app",
          state: "READY",
          readyState: "READY",
          alias: ["harness-gui.vercel.app"],
        }),
      });

    const { resolveCanonicalProductionTarget } = await import(
      "../../src/setup/vercel-setup-client.js"
    );
    const target = await resolveCanonicalProductionTarget({
      vercelToken: "vercel-token",
      projectId: "proj-1",
      teamId: "team-1",
    });

    expect(target?.source).toBe("stable_alias");
    expect(target?.productionUrl).toBe("https://harness-gui.vercel.app");
    expect(target?.webhookUrl).toBe(
      "https://harness-gui.vercel.app/api/linear-webhook",
    );
    expect(target?.deploymentUrl).toBe(
      "agentic-product-development-harness-da4vir36l-kinterra-team-url.vercel.app",
    );
  });
});

describe("vercel production redeploy client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("lists production deployments with state filter", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        deployments: [
          {
            uid: "dpl-ready",
            url: "harness-gui.vercel.app",
            state: "READY",
            readyState: "READY",
          },
        ],
      }),
    });

    const { listVercelProductionDeployments } = await import(
      "../../src/setup/vercel-setup-client.js"
    );
    const deployments = await listVercelProductionDeployments(
      "vercel-token",
      "proj-1",
      "team-1",
      { state: "READY", limit: 3 },
    );

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("projectId=proj-1");
    expect(String(url)).toContain("target=production");
    expect(String(url)).toContain("state=READY");
    expect(String(url)).toContain("teamId=team-1");
    expect(deployments[0]?.id).toBe("dpl-ready");
  });

  it("triggers production redeploy from an existing deployment id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        uid: "dpl-new",
        url: "harness-gui-new.vercel.app",
        state: "BUILDING",
        readyState: "BUILDING",
      }),
    });

    const { triggerVercelProductionRedeploy } = await import(
      "../../src/setup/vercel-setup-client.js"
    );
    const deployment = await triggerVercelProductionRedeploy("vercel-token", {
      projectName: "harness-gui",
      sourceDeploymentId: "dpl-source",
      teamId: "team-1",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/v13/deployments");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "harness-gui",
      deploymentId: "dpl-source",
      target: "production",
    });
    expect(deployment.id).toBe("dpl-new");
  });

  it("fetches deployment status for polling", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        uid: "dpl-new",
        url: "harness-gui-new.vercel.app",
        state: "READY",
        readyState: "READY",
      }),
    });

    const { getVercelDeployment } = await import(
      "../../src/setup/vercel-setup-client.js"
    );
    const deployment = await getVercelDeployment(
      "vercel-token",
      "dpl-new",
      "team-1",
    );

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/v13/deployments/dpl-new");
    expect(String(url)).toContain("teamId=team-1");
    expect(deployment.readyState).toBe("READY");
  });
});

describe("vercel create-new bridge client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("creates projects with a GitHub repository link when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "proj-created",
        name: "new-harness-gui",
        accountId: "acct-1",
        gitRepository: { type: "github", repo: "owner/p-dev-harness" },
      }),
    });

    const project = await createVercelProject("vercel-token", {
      name: "new-harness-gui",
      teamId: "team-1",
      gitRepository: { type: "github", repo: "owner/p-dev-harness" },
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/v11/projects");
    expect(String(url)).toContain("teamId=team-1");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "new-harness-gui",
      gitRepository: { type: "github", repo: "owner/p-dev-harness" },
    });
    expect(project.gitRepository?.repo).toBe("owner/p-dev-harness");
  });

  it("creates production file deployments with curated bridge files", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        uid: "dpl-created",
        url: "new-harness-gui.vercel.app",
        state: "READY",
        readyState: "READY",
      }),
    });

    const deployment = await createVercelDeployment("vercel-token", {
      projectName: "new-harness-gui",
      teamId: "team-1",
      files: [
        {
          file: "api/linear-webhook.js",
          data: "module.exports = () => {};",
          encoding: "utf-8",
        },
      ],
      projectSettings: { framework: null },
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(String(url)).toContain("/v13/deployments");
    expect(init?.method).toBe("POST");
    expect(body).toMatchObject({
      name: "new-harness-gui",
      target: "production",
      projectSettings: { framework: null },
    });
    expect(body.files).toEqual([
      expect.objectContaining({ file: "api/linear-webhook.js" }),
    ]);
    expect(deployment.id).toBe("dpl-created");
  });
});

describe("createVercelTeam provider errors", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps payment_method_required to a clear provider billing error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            code: "payment_method_required",
            message:
              "A payment method is required to create a team, please try creating a team again with a new payment method.",
          },
        }),
    });

    await expect(
      createVercelTeam("vercel-token", { slug: "new-team" }),
    ).rejects.toBeInstanceOf(VercelTeamBillingError);
  });
});
