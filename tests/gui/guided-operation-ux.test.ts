import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("guided operation UX contracts", () => {
  it("keeps Step 3 on the success panel instead of auto-continuing", () => {
    const source = readSource(
      "apps/gui/components/custom/guided-vercel-bridge-card.tsx",
    );

    expect(source).not.toContain("continueGuardRef");
    expect(source).not.toContain("onContinue();");
    expect(source).toContain("onStepCompleted?.()");
    expect(source).toContain("<GuidedStepSuccessPanel");
    expect(source).toContain("Continue to Step 4");
  });

  it("keeps Step 3 apply preview internal until Preview is clicked", () => {
    const source = readSource(
      "apps/gui/components/custom/guided-vercel-bridge-card.tsx",
    );

    expect(source).toContain("const [previewDisclosed, setPreviewDisclosed]");
    expect(source).toContain("setPreviewDisclosed(true);");
    expect(source).toContain("previewDisclosed && previewIsCurrent && preview");
    expect(source).toMatch(
      /const currentPreview =[\s\S]*previewIsCurrent && preview \? preview : await runPreview\(\);/,
    );
  });

  it("holds Steps 1-3 at success until explicit Continue", () => {
    const configureExperience = readSource(
      "apps/gui/components/custom/configure-experience.tsx",
    );
    const configureWorkflow = readSource(
      "apps/gui/components/custom/configure-workflow.tsx",
    );
    const linearCard = readSource(
      "apps/gui/components/custom/guided-linear-workspace-card.tsx",
    );
    const vercelCard = readSource(
      "apps/gui/components/custom/guided-vercel-bridge-card.tsx",
    );

    expect(configureExperience).toContain("awaitingContinueStep");
    expect(configureExperience).toContain(
      'holdGuidedStepForContinue("connect-services")',
    );
    expect(configureExperience).toContain(
      'holdGuidedStepForContinue("linear-workspace")',
    );
    expect(configureExperience).toContain(
      'holdGuidedStepForContinue("vercel-bridge")',
    );
    expect(configureWorkflow).toContain("onConnectServicesSucceeded?.()");
    expect(configureWorkflow).toContain("Continue to Linear workspace");
    expect(linearCard).toContain("Continue to Vercel bridge");
    expect(vercelCard).toContain("Continue to Step 4");
  });

  it("uses guided operation panels for Steps 1-3 apply/provisioning work", () => {
    const configureWorkflow = readSource(
      "apps/gui/components/custom/configure-workflow.tsx",
    );
    const linearCard = readSource(
      "apps/gui/components/custom/guided-linear-workspace-card.tsx",
    );
    const vercelCard = readSource(
      "apps/gui/components/custom/guided-vercel-bridge-card.tsx",
    );

    expect(configureWorkflow).toContain("HARNESS_PROVISIONING_PHASES");
    expect(configureWorkflow).toContain("<GuidedOperationPanel");
    expect(linearCard).toContain("LINEAR_OPERATION_PHASES");
    expect(linearCard).toContain('fetch("/api/setup/linear-setup-progress")');
    expect(vercelCard).toContain("VERCEL_OPERATION_PHASES");
    expect(vercelCard).toContain("resolveVercelOperationActiveIndex");
  });

  it("validates Vercel project names and passes existing-project install confirmation", () => {
    const source = readSource(
      "apps/gui/components/custom/guided-vercel-bridge-card.tsx",
    );

    expect(source).toContain("validateVercelProjectName");
    expect(source).toContain("projectNameValidation.error");
    expect(source).toContain("allowExistingProjectBridgeInstall");
    expect(source).toContain("PDev-managed");
  });
});
