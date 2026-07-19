import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readLinearCardSource(): string {
  return readFileSync(
    path.join(
      repoRoot,
      "apps/gui/components/custom/guided-linear-workspace-card.tsx",
    ),
    "utf8",
  );
}

function readLinearSettingsEditorSource(): string {
  return readFileSync(
    path.join(
      repoRoot,
      "apps/gui/components/settings/editors/linear-settings-editor.tsx",
    ),
    "utf8",
  );
}

describe("guided linear workspace card", () => {
  it("forces create-new project mode when a selected team has zero eligible projects", () => {
    const source = readLinearCardSource();

    expect(source).toContain(
      "const forceCreateProject = optionsLoaded && teamMode === \"existing\" && !hasEligibleProjects;",
    );
    expect(source).toMatch(
      /if \(projectMode !== "create"\) \{\s*setProjectMode\("create"\);/,
    );
    expect(source).toMatch(/if \(projectId !== ""\) \{\s*setProjectId\(""\);/);
    expect(source).toMatch(
      /\{!forceCreateProject \? \([\s\S]*<option value="existing">Use existing project<\/option>[\s\S]*\) : \([\s\S]*Create a new project for this Linear team\./,
    );
    expect(source).toMatch(
      /\{!forceCreateProject && projectMode === "existing" \? \([\s\S]*\) : \([\s\S]*placeholder="Project name"/,
    );
    expect(source).not.toContain("No Linear projects found for this API key.");
  });

  it("preserves existing-project mode when eligible projects exist", () => {
    const source = readLinearCardSource();

    expect(source).toContain("const hasEligibleProjects = projectOptions.length > 0;");
    expect(source).toMatch(
      /return projects\.filter\([\s\S]*project\.teamIds\.length === 0 \|\| project\.teamIds\.includes\(teamId\)/,
    );
    expect(source).toContain('<option value="existing">Use existing project</option>');
    expect(source).toContain('<option value="create">Create new project</option>');
    expect(source).toContain('value={project.id}');
  });

  it("clears stale existing-project selections when the team changes", () => {
    const source = readLinearCardSource();

    expect(source).toMatch(
      /onChange=\{\(event\) => \{\s*setTeamId\(event\.target\.value\);\s*setProjectId\(""\);\s*setAddProjectIds\(\[\]\);/,
    );
    expect(source).toContain("const selectedProjectStillEligible =");
    expect(source).toMatch(
      /if \(!selectedProjectStillEligible\) \{\s*setProjectId\(""\);\s*invalidatePreview\(\);/,
    );
  });

  it("keeps Linear Apply pending state accessible and prevents duplicate submissions", () => {
    const source = readLinearCardSource();

    expect(source).toContain("const applyInFlightRef = useRef(false);");
    expect(source).toMatch(
      /if \(!confirmed \|\| loading !== null \|\| applyInFlightRef\.current\) \{\s*return;/,
    );
    expect(source).toContain("applyInFlightRef.current = true;");
    expect(source).toContain("applyInFlightRef.current = false;");
    expect(source).toContain("<GuidedOperationPanel");
    expect(source).toContain('loading === "apply"');
    expect(source).toMatch(/disabled=\{[\s\S]*loading !== null[\s\S]*!confirmed/);
    expect(source).toContain("Apply Linear workspace setup");
  });

  it("uses guided progress and success panels instead of Apply shimmer", () => {
    const source = readLinearCardSource();

    expect(source).not.toContain('from "framer-motion"');
    expect(source).not.toContain("<motion.span");
    expect(source).toContain("LINEAR_OPERATION_PHASES");
    expect(source).toContain('fetch("/api/setup/linear-setup-progress")');
    expect(source).toContain("<GuidedStepSuccessPanel");
    expect(source).toContain("onStepCompleted?.()");
  });

  it("keeps implicit apply preview internal until Preview is clicked", () => {
    const source = readLinearCardSource();

    expect(source).toContain("const [previewDisclosed, setPreviewDisclosed]");
    expect(source).toContain("setPreviewDisclosed(true);");
    expect(source).toContain("previewDisclosed && previewIsCurrent && preview");
    expect(source).toMatch(
      /const currentPreview =[\s\S]*previewIsCurrent && previewMode === "workspace" && workspacePreview[\s\S]*: \(\(await previewLinearWorkspace\(/,
    );
  });

  it("supports multi team and project draft associations with shared helpers", () => {
    const source = readLinearCardSource();

    expect(source).toContain('from "@/lib/linear-association-draft"');
    expect(source).toContain("addProjectsToDraft");
    expect(source).toContain("groupAssociationsByTeam");
    expect(source).toContain("removeDraftAssociation");
    expect(source).toContain("removeDraftTeam");
    expect(source).toContain("buildConfiguredAssociationKeys");
    expect(source).toContain("Draft associations");
    expect(source).toContain("Add to draft");
    expect(source).toContain("addProjectIds");
    expect(source).toContain("already in draft");
  });

  it("uses the same workspace apply contracts as Settings when repos exist", () => {
    const source = readLinearCardSource();

    expect(source).toContain("previewLinearWorkspace");
    expect(source).toContain("applyLinearWorkspace");
    expect(source).toContain("buildWorkspacePlanPayload");
    expect(source).toContain("expectedCommittedFingerprint");
    expect(source).toContain('fetch("/api/setup/linear-workspace-editor-state")');
  });

  it("rejects duplicate draft associations via linearAssociationKey", () => {
    const source = readLinearCardSource();

    expect(source).toContain("linearAssociationKey");
    expect(source).toContain("configuredKeys.has(key)");
    expect(source).toContain("addProjectsToDraft");
  });

  it("hides confirmation while apply is running and keeps success until Continue", () => {
    const source = readLinearCardSource();

    expect(source).toMatch(
      /\{loading !== "apply" && !verifiedSuccess \? \([\s\S]*<RemoteActionConfirmation/,
    );
    expect(source).toMatch(
      /\{!verifiedSuccess && loading !== "apply" \? \([\s\S]*Apply Linear workspace setup/,
    );
    expect(source).toContain("verifiedSuccess && applyResult");
    expect(source).toContain("onContinue={onContinue}");
  });
});

describe("linear settings editor shared draft helpers", () => {
  it("imports shared draft helpers instead of local duplicates", () => {
    const source = readLinearSettingsEditorSource();

    expect(source).toContain('from "@/lib/linear-association-draft"');
    expect(source).toContain("addProjectsToDraft");
    expect(source).toContain("buildConfiguredAssociationKeys");
    expect(source).not.toMatch(/function groupAssociationsByTeam\(/);
  });
});
