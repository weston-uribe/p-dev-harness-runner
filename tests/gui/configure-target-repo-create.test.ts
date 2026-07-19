import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("configure target repo create/connect", () => {
  it("exposes create vs connect mode with provisioning APIs", () => {
    const source = read(
      "apps/gui/components/custom/target-repo-create-connect.tsx",
    );

    expect(source).toContain('value="create"');
    expect(source).toContain('value="connect"');
    expect(source).toContain("Create new product repository");
    expect(source).toContain("Connect existing repository");
    expect(source).toContain("/api/setup/preview-target-repo-provisioning");
    expect(source).toContain("/api/setup/apply-target-repo-provisioning");
    expect(source).toContain('useState<"private" | "public">("private")');
    expect(source).toContain("confirm-target-repo-create");
    expect(source).not.toContain("treat as new product");
    expect(source).not.toContain("apply-local-files");
    expect(source).toContain(
      "Does not write local `.harness/config.local.json` or `.env.local`",
    );
  });

  it("integrates create/connect into guided Step 4 workflow", () => {
    const workflowSource = read("apps/gui/components/custom/configure-workflow.tsx");
    const formSource = read("apps/gui/components/custom/target-repo-config-form.tsx");

    expect(workflowSource).toContain("TargetRepoCreateConnect");
    expect(workflowSource).toContain("handleTargetRepoCreated");
    expect(workflowSource).toContain('guidedSection="harness"');
    expect(workflowSource).toContain('guidedSection="target-repos"');
    expect(workflowSource).toContain('previewProvider: "none"');
    expect(workflowSource).toContain('baseBranch: "dev"');
    expect(workflowSource).toContain('productionBranch: "main"');
    expect(formSource).toContain('guidedSection?: "full" | "harness" | "target-repos"');
  });

  it("does not auto-call apply-local-files after repository create apply", () => {
    const workflowSource = read("apps/gui/components/custom/configure-workflow.tsx");
    const createConnectSource = read(
      "apps/gui/components/custom/target-repo-create-connect.tsx",
    );

    expect(createConnectSource).not.toContain("apply-local-files");
    expect(createConnectSource).not.toContain("preview-local-files");
    expect(createConnectSource).not.toContain("onGuidedLocalApplySuccess");

    const handleCreatedStart = workflowSource.indexOf(
      "const handleTargetRepoCreated = useCallback(",
    );
    expect(handleCreatedStart).toBeGreaterThan(-1);
    const handleCreatedEnd = workflowSource.indexOf(
      "const handleServiceBlur = useCallback(",
      handleCreatedStart,
    );
    const handleCreatedBlock = workflowSource.slice(handleCreatedStart, handleCreatedEnd);

    expect(handleCreatedBlock).not.toContain("apply-local-files");
    expect(handleCreatedBlock).not.toContain("preview-local-files");
    expect(handleCreatedBlock).not.toContain("onGuidedLocalApplySuccess");
    expect(handleCreatedBlock).toContain('previewProvider: "none"');
    expect(handleCreatedBlock).toContain("invalidatePreview");
  });

  it("target repositories settings page uses a compact repository list", () => {
    const repositoriesPage = read("apps/gui/app/settings/(console)/repositories/page.tsx");
    const repositoriesEditor = read(
      "apps/gui/components/settings/editors/repositories-settings-editor.tsx",
    );
    const overviewLoader = read(
      "apps/gui/lib/settings/load-target-repo-overview-fields.ts",
    );

    expect(repositoriesPage).toContain("RepositoriesSettingsEditor");
    expect(repositoriesPage).not.toContain("TargetRepositoriesOverview");
    expect(repositoriesEditor).toContain("Remove from PDev");
    expect(repositoriesEditor).toContain("Edit branches");
    expect(repositoriesEditor).toContain("Verify or repair");
    expect(repositoriesEditor).toContain("TargetRepoCreateConnect");
    expect(repositoriesEditor).not.toContain("Detach repository");
    expect(repositoriesEditor).not.toContain("Delete repository");
    expect(repositoriesEditor).not.toContain("linear-team-key");
    expect(repositoriesEditor).not.toContain("Model ID");
    expect(repositoriesEditor).not.toContain("preview-provider");
    expect(repositoriesEditor).not.toContain("validation-commands");
    expect(repositoriesEditor).not.toContain("integration-success-status");
    expect(overviewLoader).toContain("productionBranch");
    expect(overviewLoader).toContain("connectionStatus");
    expect(overviewLoader).not.toContain("previewProvider");
  });
});
