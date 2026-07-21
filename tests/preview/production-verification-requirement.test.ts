import { describe, expect, it } from "vitest";
import {
  configRequiresVercelProductionDeploymentVerification,
  repoRequiresVercelProductionDeploymentVerification,
  requiresVercelProductionDeploymentVerification,
} from "../../src/preview/production-verification-requirement.js";
import { resolveRequiredHarnessActionsSecretNames } from "../../src/setup/remote-actions.js";

describe("shared Vercel production-verification predicate", () => {
  it("requires verification only for vercel preview providers", () => {
    expect(
      requiresVercelProductionDeploymentVerification({
        previewProvider: "vercel",
      }),
    ).toBe(true);
    expect(
      requiresVercelProductionDeploymentVerification({
        previewProvider: "none",
      }),
    ).toBe(false);
  });

  it("does not require runner VERCEL_TOKEN when base equals production", () => {
    expect(
      repoRequiresVercelProductionDeploymentVerification({
        id: "same-branch",
        previewProvider: "vercel",
        baseBranch: "main",
        productionBranch: "main",
      }),
    ).toBe(false);
    expect(
      repoRequiresVercelProductionDeploymentVerification({
        id: "portfolio",
        previewProvider: "vercel",
        baseBranch: "dev",
        productionBranch: "main",
      }),
    ).toBe(true);
  });

  it("drives conditional secret inventory from the same predicate", () => {
    const without = resolveRequiredHarnessActionsSecretNames({
      repos: [
        {
          id: "none",
          previewProvider: "none",
          baseBranch: "dev",
          productionBranch: "main",
        },
      ],
    });
    expect(without).not.toContain("VERCEL_TOKEN");

    const withVercel = resolveRequiredHarnessActionsSecretNames({
      repos: [
        {
          id: "portfolio",
          previewProvider: "vercel",
          baseBranch: "dev",
          productionBranch: "main",
        },
      ],
    });
    expect(withVercel).toContain("VERCEL_TOKEN");
    expect(
      configRequiresVercelProductionDeploymentVerification({
        repos: [
          {
            id: "portfolio",
            previewProvider: "vercel",
            baseBranch: "dev",
            productionBranch: "main",
          },
        ],
      }),
    ).toBe(true);
  });
});
