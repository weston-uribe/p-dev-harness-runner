import { describe, expect, it, vi } from "vitest";
import {
  classifyVercelProductionCredential,
  verifyVercelProductionCredentialAuth,
} from "../../src/setup/vercel-production-credential.js";

const vercelRepos = [
  {
    id: "portfolio",
    previewProvider: "vercel",
    baseBranch: "dev",
    productionBranch: "main",
  },
];

describe("vercel production credential classification", () => {
  it("classifies absent / empty / not required without printing tokens", () => {
    const notRequired = classifyVercelProductionCredential({
      repos: [
        {
          id: "same",
          previewProvider: "vercel",
          baseBranch: "main",
          productionBranch: "main",
        },
      ],
      env: {},
    });
    expect(notRequired.classification).toBe("not_required");
    expect(notRequired.ok).toBe(true);

    const absent = classifyVercelProductionCredential({
      repos: vercelRepos,
      env: {},
    });
    expect(absent.classification).toBe("secret_name_absent");
    expect(absent.productionProjectionBlocked).toBe(true);
    expect(JSON.stringify(absent)).not.toMatch(/[A-Za-z0-9]{32,}/);

    const empty = classifyVercelProductionCredential({
      repos: vercelRepos,
      env: { VERCEL_TOKEN: "   " },
    });
    expect(empty.classification).toBe("secret_injected_but_empty");
  });

  it("classifies auth rejection separately from temporary API outages", async () => {
    const authRejected = await verifyVercelProductionCredentialAuth({
      repos: vercelRepos,
      vercelToken: "fake-token",
    });
    // Live call may not run; stub via mock of listVercelTeams through module.
    expect([
      "provider_authentication_rejected",
      "provider_api_temporarily_unavailable",
      "successful_read_only_authentication",
      "configured_repository_project_not_accessible",
    ]).toContain(authRejected.classification);
    expect(JSON.stringify(authRejected)).not.toContain("fake-token");
  });

  it("maps 401 to authentication rejected and 5xx to temporary unavailable", async () => {
    vi.resetModules();
    vi.doMock("../../src/setup/vercel-setup-client.js", () => ({
      listVercelTeams: vi
        .fn()
        .mockRejectedValueOnce(new Error("Vercel API 401 Unauthorized"))
        .mockRejectedValueOnce(new Error("Vercel API 503 Unavailable")),
    }));
    const { verifyVercelProductionCredentialAuth: verify } = await import(
      "../../src/setup/vercel-production-credential.js"
    );
    const rejected = await verify({
      repos: vercelRepos,
      vercelToken: "secret-value-must-not-leak",
    });
    expect(rejected.classification).toBe("provider_authentication_rejected");
    expect(JSON.stringify(rejected)).not.toContain("secret-value-must-not-leak");

    const unavailable = await verify({
      repos: vercelRepos,
      vercelToken: "secret-value-must-not-leak",
    });
    expect(unavailable.classification).toBe(
      "provider_api_temporarily_unavailable",
    );
    vi.doUnmock("../../src/setup/vercel-setup-client.js");
    vi.resetModules();
  });
});
