import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE,
  GITHUB_CLASSIC_PAT_SCOPES,
  GITHUB_PAT_SETTINGS_URL,
  GITHUB_TOKEN_GUIDED_HELPER_TEXT,
  GITHUB_TOKEN_HELP_DISCLOSURE_LABEL,
  GITHUB_TOKEN_INPUT_LABEL,
  GITHUB_TOKEN_VERIFY_HELP_HINT,
} from "../../src/setup/github-workflow-permissions.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const M6_GUI_COMPONENTS = [
  "apps/gui/components/custom/configure-experience.tsx",
  "apps/gui/components/custom/first-run-stepper.tsx",
  "apps/gui/components/custom/readiness-banner.tsx",
  "apps/gui/components/custom/configure-workflow.tsx",
  "apps/gui/components/custom/environment-config-form.tsx",
  "apps/gui/components/custom/github-token-help-disclosure.tsx",
  "apps/gui/components/custom/target-repo-config-form.tsx",
  "apps/gui/components/custom/remote-setup-section.tsx",
  "apps/gui/components/custom/primary-setup-task-card.tsx",
  "apps/gui/components/custom/guided-local-readiness-card.tsx",
  "apps/gui/components/custom/guided-cloud-secrets-card.tsx",
  "apps/gui/components/custom/guided-target-workflow-card.tsx",
  "apps/gui/components/custom/workflow-install-pending-panel.tsx",
  "apps/gui/components/custom/setup-checklist.tsx",
];

const FORBIDDEN_STORAGE_PATTERNS = [
  /localStorage/,
  /sessionStorage/,
  /indexedDB/i,
  /document\.cookie/,
];

const FORBIDDEN_RUN_TRIGGERS = [
  /harness:run/i,
  /Run first issue/i,
  /Trigger harness phase/i,
  /repository_dispatch/i,
];

describe("M6 configure GUI boundaries", () => {
  for (const relativePath of M6_GUI_COMPONENTS) {
    it(`${relativePath} does not persist secrets in browser storage`, () => {
      const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
      for (const pattern of FORBIDDEN_STORAGE_PATTERNS) {
        expect(source).not.toMatch(pattern);
      }
    });
  }

  it("guided configure experience does not expose live harness run triggers", () => {
    const source = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );

    for (const pattern of FORBIDDEN_RUN_TRIGGERS) {
      expect(source).not.toMatch(pattern);
    }
    expect(source).toContain("prohibitedActionsNote");
    expect(source).toContain("Setup complete");
    expect(source).toContain('title="Setup complete"');
    expect(source).not.toContain("Blocked for first run");
    expect(source).not.toContain("ConfigureMode");
    expect(source).not.toContain("Advanced checklist view");
    expect(source).not.toContain("SetupDashboard");
    expect(source).toContain("GuidedLocalReadinessCard");
    expect(source).toContain("GuidedCloudSecretsCard");
    expect(source).toContain("GuidedTargetWorkflowCard");
    expect(source).toContain("remoteSetupBlockedByUpstream");
    expect(source).not.toContain("PrimarySetupTaskCard");
  });

  it("configure experience uses stable guarded UI-state handlers", () => {
    const source = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );

    expect(source).toContain("useCallback");
    expect(source).toContain("handleLocalUiStateChange");
    expect(source).toContain("handleRemoteUiStateChange");
    expect(source).toContain("onUiStateChange={handleLocalUiStateChange}");
    expect(source).toContain("onUiStateChange={handleRemoteUiStateChange}");
    expect(source).not.toContain("onLocalUiStateChange=");
    expect(source).not.toContain("onRemoteUiStateChange=");
    expect(source).toContain("cloudSecretsApplyEvidence");
    expect(source).toContain("remoteSecretPreviewStale");
    expect(source).not.toMatch(
      /onUiStateChange=\{\(state\) =>\s*\n?\s*setUiState/,
    );
  });

  it("first-run stepper follows readiness current step changes", () => {
    const source = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/first-run-stepper.tsx"),
      "utf8",
    );

    expect(source).toContain("useEffect");
    expect(source).toContain("setExpandedStepId(readiness.currentStepId)");
    expect(source).toContain("[readiness.currentStepId]");
  });

  it("configure page uses Initial Harness Configuration title", () => {
    const source = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );

    expect(source).toContain("Initial Harness Configuration");
    expect(source).not.toContain("Settings / Configure");
  });

  it("guided configure experience hides readiness diagnostics by default", () => {
    const source = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );

    expect(source).not.toContain("ReadinessBanner");
    expect(source).not.toContain("Advanced checklist view");
    expect(source).not.toContain("SetupDashboard");
    expect(source).toContain('mode="guided"');
    expect(source).toContain("switch (displayedGuidedStep)");
    expect(source).toContain('case "local-readiness":');
    expect(source).toContain("GuidedSetupProgress");
    expect(source).not.toContain("PrimarySetupTaskCard");
    expect(source).not.toContain("configBadgeLabel");
  });

  it("guided workflow renders one active step with animated transitions", () => {
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );
    const transitionSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-step-transition.tsx",
      ),
      "utf8",
    );
    const progressSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-setup-progress.tsx",
      ),
      "utf8",
    );

    expect(workflowSource).not.toContain("GuidedStepTransition");
    expect(experienceSource).toContain("GuidedStepTransition");
    expect(experienceSource).toContain("getGuidedTransitionDirection");
    expect(experienceSource).toContain('stepKey={displayedGuidedStep}');
    expect(workflowSource).not.toContain("Back to service keys");
    expect(workflowSource).not.toContain("Back to target repo");
    expect(workflowSource).not.toContain(
      "Service keys are ready. You can go back to edit them.",
    );
    expect(workflowSource).not.toContain(
      "Target repo is set. You can go back to change it before applying.",
    );
    expect(transitionSource).toContain('mode="wait"');
    expect(transitionSource).toContain('x: "100vw"');
    expect(transitionSource).toContain('x: "-100vw"');
    expect(transitionSource).toContain("overflow-x-hidden");
    expect(transitionSource).toContain("panelRef?.current?.contains(document.activeElement)");
    expect(progressSource).toContain("GuidedProgressCheck");
  });

  it("guided workflow hides advanced fields from default view", () => {
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );
    const envSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/environment-config-form.tsx"),
      "utf8",
    );
    const targetSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/target-repo-config-form.tsx"),
      "utf8",
    );

    expect(workflowSource).toContain('variant="guided-services"');
    expect(workflowSource).toContain('variant="guided-minimal"');
    expect(workflowSource).toContain("Step 1 of ${GUIDED_SETUP_STEP_COUNT}");
    expect(workflowSource).toContain("Step 4 of ${GUIDED_SETUP_STEP_COUNT}");
    expect(workflowSource).toContain("Create local setup files");
    expect(workflowSource).toContain("ReviewGeneratedFilesDisclosure");
    expect(workflowSource).toContain("/api/setup/verify-service");
    expect(workflowSource).toContain("/api/setup/verify-target-repo");
    expect(workflowSource).not.toContain("Step 3 of 3");
    expect(workflowSource).not.toContain(
      "Review and create local setup files",
    );
    expect(envSource).toContain('variant === "guided-services"');
    const guidedEnvBlock = envSource.match(
      /if \(variant === "guided-services"\) \{([\s\S]*?)\n  \}/,
    )?.[1];
    expect(guidedEnvBlock).toBeDefined();
    expect(guidedEnvBlock).not.toContain("GITHUB_DISPATCH_REPOSITORY");
    expect(guidedEnvBlock).toContain("ServiceConnectionCard");
    expect(guidedEnvBlock).not.toContain("envKey");
    expect(guidedEnvBlock).toContain("space-y-4");
    expect(targetSource).toContain('variant === "guided-minimal"');
    const guidedTargetBlock = targetSource.match(
      /if \(variant === "guided-minimal"\) \{([\s\S]*?)\n  \}/,
    )?.[1];
    expect(guidedTargetBlock).toBeDefined();
    expect(guidedTargetBlock).not.toContain("Model ID");
    expect(guidedTargetBlock).not.toContain("Repo config ID");
    expect(guidedTargetBlock).not.toContain("Validation commands");
    expect(guidedTargetBlock).toContain("Add additional repo");
  });

  it("checkbox component uses pointer cursor when enabled", () => {
    const checkboxSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/ui/checkbox.tsx"),
      "utf8",
    );

    expect(checkboxSource).toContain("cursor-pointer");
    expect(checkboxSource).toContain("disabled:cursor-not-allowed");
  });

  it("verification API routes are read-only and do not log secrets", () => {
    const verifyServiceSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/app/api/setup/verify-service/route.ts",
      ),
      "utf8",
    );
    const verifyRepoSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/app/api/setup/verify-target-repo/route.ts",
      ),
      "utf8",
    );

    for (const source of [verifyServiceSource, verifyRepoSource]) {
      expect(source).toContain('export const dynamic = "force-dynamic"');
      expect(source).not.toMatch(/console\.(log|info|debug|warn|error)/);
      expect(source).not.toMatch(/localStorage|sessionStorage/);
    }
  });

  it("local and remote workflows preserve confirmation gates", () => {
    const localSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );
    const remoteSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/remote-setup-section.tsx"),
      "utf8",
    );

    expect(localSource).toContain("LocalWriteConfirmation");
    expect(localSource).toContain("confirmed: true");
    expect(localSource).toContain("fingerprint: applyPreview.fingerprint");
    expect(localSource).toContain("disabledReason");
    expect(remoteSource).toContain("RemoteActionConfirmation");
    expect(remoteSource).toContain("confirmed: true");
    expect(remoteSource).toContain("fingerprint: preview.fingerprint");
    expect(remoteSource).toContain("disabledReason");
    expect(remoteSource).toContain("blockedByUpstream");
  });

  it("guided workflow uses exact-value verification, stable repo row ids, and scroll reset", () => {
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );
    const envSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/environment-config-form.tsx"),
      "utf8",
    );
    const targetSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/target-repo-config-form.tsx"),
      "utf8",
    );

    expect(workflowSource).toContain("guidedTopRef");
    expect(workflowSource).toContain("goToGuidedStep");
    expect(workflowSource).toContain("scrollIntoView");
    expect(workflowSource).toContain("guidedRepoRows");
    expect(workflowSource).toContain("resetRepoVerificationIfUrlChanged");
    expect(workflowSource).toContain("clearAllRepoVerification");
    expect(workflowSource).toContain("canCreateSetupFiles");
    expect(workflowSource).toContain("ReviewGeneratedFilesDisclosure");
    expect(workflowSource).toContain("handlePreviewDisclosureOpenChange");
    expect(workflowSource).toContain("disabledReason={guidedConfirmDisabledReason}");

    expect(envSource).toContain("verifiedValueFingerprint");
    expect(envSource).toContain('"Verified"');
    expect(envSource).toContain("Verify and save");
    expect(envSource).toContain("ServiceIcon");
    expect(envSource).toContain("ConnectedStatusMessage");

    expect(targetSource).toContain("rowId");
    expect(targetSource).toContain("RepoIcon");
    expect(targetSource).toContain("verifiedTargetRepo");
    expect(targetSource).toContain('"Verified"');
  });

  it("review disclosure auto-generates preview with loading treatment", () => {
    const disclosureSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/review-generated-files-disclosure.tsx",
      ),
      "utf8",
    );
    const previewSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/local-write-preview.tsx"),
      "utf8",
    );
    const confirmationSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/local-write-confirmation.tsx"),
      "utf8",
    );

    expect(disclosureSource).toContain("Generating redacted local file changes");
    expect(disclosureSource).toContain("Skeleton");
    expect(disclosureSource).toContain('variant="guided"');
    expect(disclosureSource).toContain("previewError");
    expect(disclosureSource).toContain("event.preventDefault()");
    expect(disclosureSource).not.toContain("onToggle");
    expect(previewSource).toContain('variant === "guided"');
    expect(confirmationSource).not.toMatch(
      /variant === "guided"[\s\S]*Generate a preview before you can confirm this write/,
    );
  });

  it("guided connect-services copy is action-oriented and hides milestone footer", () => {
    const envSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/environment-config-form.tsx"),
      "utf8",
    );
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );
    const linearCardSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-linear-workspace-card.tsx",
      ),
      "utf8",
    );

    expect(envSource).toContain(
      "Copy an existing Linear API key or create a new one, then paste it here.",
    );
    expect(envSource).toContain(
      "Copy an existing Cursor API key or create a new one, then paste it here.",
    );
    expect(envSource).toContain(
      "Copy an existing Vercel token or create a new one, then paste it here.",
    );
    expect(envSource).toContain(
      "Lets the harness read and update Linear issues.",
    );
    expect(envSource).toContain(
      "Used to spin up Cursor agents that do the planning and development work.",
    );
    expect(envSource).toContain(
      "Used to configure the PDev automation bridge hosted on Vercel (not target-app preview deployment).",
    );
    expect(envSource).not.toContain("during later automation phases");
    expect(envSource).not.toContain("Lets later Cursor SDK runs authenticate.");
    expect(envSource).not.toContain('inputLabel: "Paste your Vercel token"');
    expect(envSource).toContain("flex flex-col items-start gap-2");
    expect(envSource).toContain("Verify and save");
    expect(envSource).toContain("Verifying and saving…");

    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );
    expect(workflowSource).toContain("verifyAndSaveService");
    expect(workflowSource).toContain("saveConnectServiceKey");
    expect(workflowSource).not.toContain("Save service keys");
    expect(workflowSource).not.toContain("handleSaveConnectServices");

    const guidedPanelBlock = experienceSource.match(
      /<GuidedStepTransition[\s\S]*?\{renderGuidedActionPanel\(\)\}[\s\S]*?<\/GuidedStepTransition>/,
    )?.[0];
    expect(guidedPanelBlock).toBeDefined();
    expect(guidedPanelBlock).not.toContain("prohibitedActionsNote");

    expect(linearCardSource).toContain("linearApiKeyConfigured?: boolean");
    expect(linearCardSource).toContain(
      "linearApiKeyConfigured ?? summary.linearApiKeyConfigured",
    );
    expect(linearCardSource).toContain(
      "Add your Linear API key in Step 1 before configuring the Linear workspace.",
    );
    expect(linearCardSource).not.toContain("Add LINEAR_API_KEY in Step 1");
    expect(experienceSource).toContain(
      "linearApiKeyConfigured={summary.envKeyPresence.LINEAR_API_KEY}",
    );
    expect(experienceSource).toContain("/api/setup/linear-summary");
    expect(experienceSource).toContain(
      "syncLinearSummaryFromEnvPresence(current, nextSummary.envKeyPresence)",
    );
    expect(experienceSource).toContain(
      "syncVercelSummaryFromEnvPresence(current, nextSummary.envKeyPresence)",
    );
    expect(experienceSource).toContain(
      "syncRemoteSummaryFromEnvPresence(current, nextSummary.envKeyPresence)",
    );
  });

  it("guided preview flow keeps local setup workflow mounted and step state in parent", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );

    expect(experienceSource).toContain("displayedGuidedStep");
    expect(experienceSource).toContain('key="guided-local-setup"');
    expect(experienceSource).toContain('key="guided-connect-services"');
    expect(experienceSource).toContain('case "linear-workspace":');
    expect(experienceSource).toContain('case "vercel-bridge":');
    expect(experienceSource).toContain('case "connect-services":');
    expect(experienceSource).toContain('case "choose-target-repos":');
    expect(experienceSource).not.toContain("guidedLocalSetupActive");
    expect(experienceSource).toContain("GuidedLinearWorkspaceCard");
    expect(experienceSource).toContain("GuidedVercelBridgeCard");
    expect(experienceSource).toContain("GuidedLocalReadinessCard");
    expect(experienceSource).toContain("localReadinessReviewed");
    expect(workflowSource).toContain("previewError");
    expect(workflowSource).toContain("setPreviewError");
    expect(workflowSource).toMatch(
      /const handlePreview = useCallback\(async \(\) => \{[\s\S]*?setPreviewError\(null\)/,
    );
    expect(workflowSource).toContain("guidedStepProp");
    expect(workflowSource).toContain("onGuidedStepChange");
    expect(workflowSource).not.toContain("onGuidedLocalSetupComplete");
  });

  it("guided local readiness does not render PrimarySetupTaskCard", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );
    const readinessCardSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-local-readiness-card.tsx",
      ),
      "utf8",
    );

    expect(experienceSource).not.toContain("PrimarySetupTaskCard");
    expect(experienceSource).toContain('case "local-readiness":');
    expect(experienceSource).toContain("<GuidedLocalReadinessCard");
    expect(readinessCardSource).toContain(
      "Step 5 of ${GUIDED_SETUP_STEP_COUNT} · Check local readiness",
    );
    expect(readinessCardSource).not.toContain("Target workflow differs");
    expect(readinessCardSource).not.toContain("I need this from you now");
  });

  it("guided cloud secrets and target workflow stay on separate steps", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );
    const cloudSecretsSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-cloud-secrets-card.tsx",
      ),
      "utf8",
    );
    const targetWorkflowSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-target-workflow-card.tsx",
      ),
      "utf8",
    );
    const readinessCardSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-local-readiness-card.tsx",
      ),
      "utf8",
    );

    expect(experienceSource).toContain('case "cloud-secrets":');
    expect(experienceSource).toContain('case "target-workflow":');
    expect(experienceSource).toContain("<GuidedCloudSecretsCard");
    expect(experienceSource).toContain("<GuidedTargetWorkflowCard");
    expect(cloudSecretsSource).toContain(
      'Step 6 of ${GUIDED_SETUP_STEP_COUNT} ${"\\u00b7"} Connect cloud secrets',
    );
    expect(targetWorkflowSource).toContain(
      "Step 7 of ${GUIDED_SETUP_STEP_COUNT} · Install target repo workflow",
    );
    expect(cloudSecretsSource).not.toContain("TargetWorkflowPrCard");
    expect(targetWorkflowSource).not.toContain("RemoteSecretForm");
    expect(cloudSecretsSource).not.toContain("apply harness secrets");
    expect(cloudSecretsSource).toContain("Manual setup");
    expect(cloudSecretsSource).toContain("deriveStep6ContinueEligibility");
    expect(cloudSecretsSource).toContain("setupSummary");
    expect(experienceSource).toContain("setupSummary={summary}");
    expect(cloudSecretsSource).toContain("/api/setup/remote-summary");
    expect(cloudSecretsSource).not.toContain("localStorage");
    expect(cloudSecretsSource).not.toContain("sessionStorage");
    expect(targetWorkflowSource).not.toContain("workflow differs");
    expect(readinessCardSource).not.toContain("RemoteSetupSection");
    expect(readinessCardSource).not.toContain("TargetWorkflowPrCard");
  });

  it("Continue to cloud secrets appears only when local readiness passes", () => {
    const readinessCardSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-local-readiness-card.tsx",
      ),
      "utf8",
    );
    const routeSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/app/api/setup/local-readiness/route.ts",
      ),
      "utf8",
    );

    expect(readinessCardSource).toContain("allPassed");
    expect(readinessCardSource).toContain("localReadinessReviewed");
    expect(readinessCardSource).toContain("Continue to cloud secrets");
    expect(readinessCardSource).toContain("/api/setup/local-readiness");
    expect(readinessCardSource).toContain("LocalReadinessChecklist");
    expect(routeSource).toContain("runLocalReadinessChecks");
    expect(routeSource).toContain("resolveHarnessWorkspaceDir");
    expect(routeSource).not.toContain("resolveHarnessRepoRoot");
    expect(readinessCardSource).not.toContain("CLI-only");
    expect(readinessCardSource).not.toContain("Milestone 3");
    expect(readinessCardSource).not.toContain("npm run harness:doctor");
    expect(readinessCardSource).not.toContain("DoctorChecklist");
  });

  it("Step 3 auto-runs shared local readiness checks with checking states", () => {
    const readinessCardSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-local-readiness-card.tsx",
      ),
      "utf8",
    );
    const checklistSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/setup-checklist.tsx"),
      "utf8",
    );

    expect(readinessCardSource).toContain('status: "checking"');
    expect(readinessCardSource).toContain("Running local readiness checks");
    expect(checklistSource).toContain("LocalReadinessChecklist");
    expect(checklistSource).toContain('"checking"');
    expect(checklistSource).toContain('"passed"');
    expect(checklistSource).toContain('"failed"');
  });

  it("guided local setup renders for connect-services and choose-target-repos display steps", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );

    expect(experienceSource).toContain('case "connect-services":');
    expect(experienceSource).toContain('case "choose-target-repos":');
    expect(experienceSource).toContain('case "local-readiness":');
    expect(experienceSource).not.toMatch(
      /guidedLocalSetupActive[\s\S]*readiness\.currentStepId === "local-setup"/,
    );
  });

  it("guided flow has no advanced checklist mode toggle", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );

    expect(experienceSource).not.toContain("Advanced checklist view");
    expect(experienceSource).not.toContain("Back to guided flow");
    expect(experienceSource).not.toContain("setMode");
    expect(experienceSource).not.toContain("ConfigureMode");
    expect(experienceSource).not.toContain("SetupDashboard");
    expect(experienceSource).not.toContain("setGuidedLocalSetupActive(true)");
    expect(experienceSource).not.toContain("guidedLocalSetupActive");
  });

  it("guided local readiness panel appears after local setup completes", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );
    const readinessCardSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-local-readiness-card.tsx",
      ),
      "utf8",
    );

    expect(readinessCardSource).toContain(
      "We're checking whether this machine is ready for remote setup.",
    );
    expect(readinessCardSource).toContain("GuidedStepSuccessPanel");
    expect(readinessCardSource).toContain("onStepCompleted");
    expect(readinessCardSource).toContain("<LocalReadinessChecklist checks={checks} />");
    expect(experienceSource).toContain("switch (displayedGuidedStep)");
    expect(experienceSource).not.toContain("readiness.primaryTask?.stepId");
    expect(experienceSource).not.toContain("PrimarySetupTaskCard");
  });

  it("guided setup surfaces GitHub workflow permission requirements in Steps 1 and 2", () => {
    const envSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/environment-config-form.tsx"),
      "utf8",
    );
    const helpSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/github-token-help-disclosure.tsx"),
      "utf8",
    );
    const targetSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/target-repo-config-form.tsx"),
      "utf8",
    );
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );

    expect(envSource).toContain("GITHUB_TOKEN_GUIDED_HELPER_TEXT");
    expect(envSource).toContain("GITHUB_TOKEN_INPUT_LABEL");
    expect(envSource).toContain("GitHubTokenHelpDisclosure");
    expect(envSource).not.toContain("Step 4");
    expect(envSource).not.toContain("Step 5");
    expect(GITHUB_TOKEN_INPUT_LABEL).toBe(
      "Copy an existing GitHub personal access token or create a new one, then paste it here.",
    );
    expect(GITHUB_TOKEN_GUIDED_HELPER_TEXT).toContain("repo and workflow access");
    expect(GITHUB_TOKEN_GUIDED_HELPER_TEXT).not.toContain("Step 4");
    expect(GITHUB_TOKEN_GUIDED_HELPER_TEXT).not.toContain("Step 5");
    expect(helpSource).toContain("GITHUB_TOKEN_HELP_DISCLOSURE_LABEL");
    expect(helpSource).toContain("GITHUB_PAT_SETTINGS_URL");
    expect(helpSource).toContain("GITHUB_CLASSIC_PAT_SCOPES");
    expect(GITHUB_PAT_SETTINGS_URL).toBe("https://github.com/settings/tokens");
    expect(GITHUB_TOKEN_HELP_DISCLOSURE_LABEL).toBe("How do I get a GitHub token?");
    expect(helpSource).toContain("Generate new token (classic)");
    expect(GITHUB_CLASSIC_PAT_SCOPES.map((scope) => scope.id)).toEqual([
      "repo",
      "workflow",
    ]);
    expect(helpSource).toContain("Advanced option");
    expect(helpSource).toContain("Fine-grained tokens can also work");
    expect(GITHUB_CLASSIC_PAT_MISSING_WORKFLOW_MESSAGE).toContain(
      GITHUB_TOKEN_HELP_DISCLOSURE_LABEL,
    );
    expect(GITHUB_TOKEN_VERIFY_HELP_HINT).toContain(
      GITHUB_TOKEN_HELP_DISCLOSURE_LABEL,
    );
    expect(targetSource).toContain("Verify repo + workflow access");
    expect(targetSource).toContain("Copy-paste the main repo URL.");
    expect(workflowSource).toContain("workflowInstallReady");
    expect(workflowSource).toContain("limitation: data.limitation");
  });

  it("Step 2 repo verification uses the active GitHub token from Step 1", () => {
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );
    const targetSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/target-repo-config-form.tsx"),
      "utf8",
    );
    const verificationSource = readFileSync(
      path.join(repoRoot, "apps/gui/lib/verification-state.ts"),
      "utf8",
    );

    expect(workflowSource).toContain("resolveActiveGitHubToken");
    expect(workflowSource).toContain("tokenContext?.tokenForRequest");
    expect(workflowSource).toContain("clearAllRepoVerification");
    expect(workflowSource).toContain("verifiedGithubTokenFingerprint");
    expect(workflowSource).toContain("servicesPersistedReady");
    expect(workflowSource).toContain("activeGithubTokenFingerprint");
    expect(workflowSource).not.toMatch(
      /envValues\.githubToken\.trim\(\)[\s\S]*?githubToken: envValues\.githubToken/,
    );
    expect(targetSource).toContain("isRepoVerifiedForActiveToken");
    expect(targetSource).toContain("githubTokenSourceHint");
    expect(verificationSource).toContain("Using current GitHub token from Step 1.");
    expect(verificationSource).toContain("resolveActiveGitHubToken");
    expect(verificationSource).toContain("SAVED_GITHUB_TOKEN_FINGERPRINT");
  });

  it("guided local apply advances to Step 3 without a dead-end summary", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );
    const confirmationSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/local-write-confirmation.tsx"),
      "utf8",
    );

    expect(experienceSource).toContain("handleGuidedLocalApplySuccess");
    expect(experienceSource).toContain("onGuidedLocalApplySuccess={handleGuidedLocalApplySuccess}");
    expect(experienceSource).toContain("GUIDED_DISPLAY_STEP_AFTER_LOCAL_APPLY");
    expect(experienceSource).toContain("localReadinessReviewed: false");
    expect(experienceSource).toContain("cloudSecretsReviewed: false");
    expect(experienceSource).toContain("remoteSecretPreviewStale: current.cloudSecretsPreviewOpened");
    expect(experienceSource).toContain("localSetupFilesExist={localSetupFilesExist(summary)}");

    const guidedSectionEnd = workflowSource.indexOf(
      'title="Environment (.env.local)"',
    );
    const guidedSection = workflowSource.slice(0, guidedSectionEnd);
    expect(guidedSection).toContain("onGuidedLocalApplySuccess?.()");
    expect(guidedSection).not.toContain("applySuccess !== null");
    expect(guidedSection).not.toContain(
      "Local setup files were written successfully.",
    );
    expect(workflowSource).toContain("Update local setup files");
    expect(workflowSource).toContain("Create local setup files");
    expect(workflowSource).toContain("confirmed: true");

    expect(confirmationSource).toContain('intent?: "create" | "update"');
    expect(confirmationSource).toContain("update local setup files");
  });

  it("guided Step 7 workflow apply shows automatic finalization progress instead of manual merge", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );
    const workflowCardSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-target-workflow-card.tsx",
      ),
      "utf8",
    );
    const prCardSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/target-workflow-pr-card.tsx"),
      "utf8",
    );
    const pendingPanelSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/workflow-install-pending-panel.tsx",
      ),
      "utf8",
    );

    expect(experienceSource).toContain("handleGuidedWorkflowSetupComplete");
    expect(experienceSource).toContain("workflowFinalizationByRepo");
    expect(experienceSource).toContain("Finalizing workflow install");
    expect(experienceSource).toContain("workflowInstallPendingByRepo");

    expect(workflowCardSource).toContain("onGuidedApplySuccess");
    expect(workflowCardSource).toContain("WorkflowInstallProgressPanel");
    expect(workflowCardSource).toContain("/api/setup/finalize-target-workflow");
    expect(workflowCardSource).not.toContain("Refresh status");
    expect(workflowCardSource).not.toContain("Merge it in GitHub");

    expect(prCardSource).toContain("onGuidedApplySuccess");
    expect(prCardSource).toContain('variant === "guided"');
    expect(prCardSource).not.toContain(
      'variant === "guided" && successMessage',
    );
    expect(prCardSource).toContain('variant === "advanced" && successMessage');

    expect(pendingPanelSource).toContain("WorkflowInstallProgressPanel");
    expect(pendingPanelSource).toContain("WORKFLOW_INSTALL_UI_PHASE_LABELS");
    expect(pendingPanelSource).toContain("GuidedOperationPanel");
    expect(pendingPanelSource).toContain("Open GitHub details");
    expect(pendingPanelSource).not.toContain("Merge the PR in GitHub");
    expect(pendingPanelSource).not.toMatch(/auto-merge|dispatch|harness phase/i);
  });

  it("guided header Back button navigates wizard steps without browser history", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );
    const guidedSetupSource = readFileSync(
      path.join(repoRoot, "apps/gui/lib/guided-setup.ts"),
      "utf8",
    );

    expect(guidedSetupSource).toContain("getPreviousGuidedDisplayStep");
    expect(guidedSetupSource).toContain("defaultGuidedDisplayStep");
    expect(guidedSetupSource).toContain("shouldShowGuidedBackButton");
    expect(experienceSource).toContain("handleGuidedBack");
    expect(experienceSource).toContain("showGuidedBackButton");
    expect(experienceSource).toContain("shouldShowGuidedBackButton(displayedGuidedStep)");
    expect(experienceSource).toContain('variant="ghost"');
    expect(experienceSource).not.toContain("Advanced checklist view");
    expect(experienceSource).not.toContain("setMode");
    expect(experienceSource).toContain("defaultGuidedDisplayStep");
    expect(experienceSource).toContain("previousReadinessStepRef");
    expect(experienceSource).toContain("shouldReadinessAdvanceGuidedDisplay");
    expect(experienceSource).toContain("invalidateDownstreamFromGuidedStep");
    expect(experienceSource).not.toContain("localPreviewStale: true");
    expect(experienceSource).not.toMatch(/history\.back|router\.back/);
    expect(experienceSource).not.toMatch(/localStorage|sessionStorage/);
  });

  it("Step 1 verify-and-save does not call onConnectServicesComplete", () => {
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );

    const verifyBlock = workflowSource.match(
      /const verifyAndSaveService = useCallback\([\s\S]*?\n  \);/,
    )?.[0];

    expect(workflowSource).toContain("verifyAndSaveService");
    expect(verifyBlock).toBeDefined();
    expect(verifyBlock).not.toContain("onConnectServicesComplete");
    // Continue advances only via GuidedStepSuccessPanel after successful provisioning.
    expect(workflowSource).toContain(
      "onContinue={onConnectServicesComplete ?? (() => undefined)}",
    );
    expect(workflowSource).toContain("onConnectServicesSucceeded?.()");
    expect(workflowSource).not.toContain("onConnectServicesComplete?.()");
  });

  it("Step 1 verification returns to a retryable failed state without clearing the token", () => {
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );
    const formSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/environment-config-form.tsx",
      ),
      "utf8",
    );

    const verifyBlock = workflowSource.match(
      /const runServiceVerification = useCallback\([\s\S]*?\n  \);/,
    )?.[0];

    expect(verifyBlock).toBeDefined();
    expect(verifyBlock).toContain('state: "checking"');
    expect(verifyBlock).toContain('state: "failed"');
    expect(verifyBlock).toContain("setVerifyingServiceKey(null)");
    expect(verifyBlock).not.toContain("setEnvValues");
    expect(workflowSource).toContain("verifyAndSaveService");
    expect(formSource).toContain("verifyButtonDisabled =");
    expect(formSource).toContain("verifying ||");
    expect(formSource).toContain("verifiedForCurrentValue");
  });

  it("explicit Continue handler remains the Step 1 to Step 2 transition", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );

    expect(experienceSource).toContain("handleConnectServicesComplete");
    expect(experienceSource).toContain(
      "setDisplayedGuidedStep(GUIDED_DISPLAY_STEP_AFTER_CONNECT_SERVICES)",
    );
    expect(experienceSource).toContain(
      "onConnectServicesComplete={handleConnectServicesComplete}",
    );
  });

  it("explicit Continue handler advances Step 6 to Step 7 target workflow", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );

    expect(experienceSource).toContain("handleCloudSecretsReviewed");
    expect(experienceSource).toContain(
      "setDisplayedGuidedStep(GUIDED_DISPLAY_STEP_AFTER_CLOUD_SECRETS)",
    );
    expect(experienceSource).toContain(
      "onContinue={handleCloudSecretsReviewed}",
    );
    expect(experienceSource).toContain('case "cloud-secrets":');
    expect(experienceSource).toContain('case "target-workflow":');
  });

  it("guided mode renders a display-only seven-stage progress indicator", () => {
    const experienceSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-experience.tsx"),
      "utf8",
    );
    const progressSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-setup-progress.tsx",
      ),
      "utf8",
    );

    expect(experienceSource).toContain("GuidedSetupProgress");
    expect(experienceSource).toContain("deriveGuidedProgressStages");
    expect(experienceSource).toContain("<GuidedSetupProgress stages={guidedProgressStages} />");
    expect(progressSource).toContain('aria-label="Guided setup progress"');
    expect(progressSource).toContain('aria-current={isCurrent ? "step" : undefined}');
    expect(progressSource).toContain("useReducedMotion");
    expect(progressSource).not.toContain("onClick");
    expect(progressSource).not.toContain("<button");
    expect(progressSource).not.toContain('role="tab"');
  });

  it("guided Step 1 uses concise workspace setup button labels", () => {
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );

    expect(workflowSource).toContain("Set up workspace");
    expect(workflowSource).toContain("GuidedOperationPanel");
    expect(workflowSource).toContain("Creating private workspace");
    expect(workflowSource).toContain("GuidedStepSuccessPanel");
    expect(workflowSource).not.toContain(
      "Continue and set up private p-dev workspace",
    );
    expect(workflowSource).not.toContain(
      "Setting up your private p-dev workspace",
    );
  });

  it("top nav renders the settings menu instead of a standalone theme toggle", () => {
    const appShellSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/app-shell.tsx"),
      "utf8",
    );
    const settingsMenuSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/settings-menu.tsx"),
      "utf8",
    );

    expect(appShellSource).toContain("ApplicationHeader");
    expect(appShellSource).not.toContain("ThemeToggle");
    expect(settingsMenuSource).toContain("Settings");
    expect(settingsMenuSource).toContain("Workflow");
    expect(settingsMenuSource).not.toContain("Setup wizard");
    expect(settingsMenuSource).not.toContain("Data sharing");
    expect(settingsMenuSource).toContain("Dark mode");
    expect(settingsMenuSource).toContain("Light mode");
  });

  it("guided linear workspace card loads teams and projects from linear-options", () => {
    const linearCardSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/guided-linear-workspace-card.tsx",
      ),
      "utf8",
    );

    expect(linearCardSource).toContain("/api/setup/linear-options");
    expect(linearCardSource).toContain('value={team.id}');
    expect(linearCardSource).toContain('value={project.id}');
    expect(linearCardSource).toContain("{team.name} ({team.key})");
    expect(linearCardSource).toContain("{project.name}");
    expect(linearCardSource).not.toContain('placeholder="Project ID"');
    expect(linearCardSource).toContain("Select a project…");
  });

  it("guided Step 4 supports create/connect target repo provisioning without silent local apply", () => {
    const workflowSource = readFileSync(
      path.join(repoRoot, "apps/gui/components/custom/configure-workflow.tsx"),
      "utf8",
    );
    const createConnectSource = readFileSync(
      path.join(
        repoRoot,
        "apps/gui/components/custom/target-repo-create-connect.tsx",
      ),
      "utf8",
    );

    expect(workflowSource).toContain("TargetRepoCreateConnect");
    expect(workflowSource).toContain("targetRepoSelectionMode");
    expect(workflowSource).toContain("handleTargetRepoCreated");
    expect(createConnectSource).toContain(
      "/api/setup/preview-target-repo-provisioning",
    );
    expect(createConnectSource).not.toContain("apply-local-files");
    expect(createConnectSource).not.toContain("onGuidedLocalApplySuccess");
  });
});
