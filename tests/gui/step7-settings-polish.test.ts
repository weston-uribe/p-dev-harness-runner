import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatLinearTeamLabel } from "../../src/config/resolve-linear-workspace.js";
import { isUnifiedDataSharingEnabled } from "../../apps/gui/lib/observability-preferences.js";
import {
  loadDurableServiceConnectionSummaries,
  resolveServiceConnectionBadgeState,
  serviceVerificationFromSummaries,
} from "../../apps/gui/lib/verification-state.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("Step 7 atomic completion and finish redirect", () => {
  it("refreshes authoritative summary before continue and gates progress Continue on allComplete", () => {
    const card = readSource(
      "apps/gui/components/custom/guided-target-workflow-card.tsx",
    );
    const experience = readSource(
      "apps/gui/components/custom/configure-experience.tsx",
    );
    const configurePage = readSource(
      "apps/gui/app/settings/configure/page.tsx",
    );

    expect(card).toContain("handleContinueWhenAllComplete");
    expect(card).toContain("await refreshSummary()");
    expect(card).toContain("allTargetWorkflowsReady(authoritativeSummary)");
    expect(card).toMatch(
      /allComplete && finalization\.lifecycle === "complete"/,
    );

    expect(experience).toContain("handleGuidedWorkflowSetupComplete");
    expect(experience).toContain('window.location.assign("/workflow")');
    expect(experience).toContain("Could not finish initial setup");
    expect(experience).toContain("setInitialSetupCompletionError");
    expect(experience).toContain("unmet");
    expect(experience).not.toMatch(
      /handleGuidedWorkflowSetupComplete[\s\S]*?window\.location\.assign\("\/settings"\)/,
    );
    expect(experience).toMatch(
      /handleTargetWorkflowContinue[\s\S]*?setDisplayedGuidedStep\(GUIDED_DISPLAY_STEP_AFTER_WORKFLOW_READY\)/,
    );

    expect(configurePage).toContain("WORKFLOW_ROUTE");
    expect(configurePage).not.toContain("SETTINGS_ROUTE");
  });
});

describe("Connections settings seeded verification", () => {
  it("seeds connected state from durable summaries without unchecked flash", () => {
    const editor = readSource(
      "apps/gui/components/settings/editors/connections-settings-editor.tsx",
    );
    const page = readSource(
      "apps/gui/app/settings/(console)/connections/page.tsx",
    );

    expect(page).toContain("initialServiceConnectionSummaries");
    expect(editor).toContain("serviceVerificationFromSummaries");
    expect(editor).toMatch(
      /useState<ServiceVerificationMap>\(\(\) =>\s*serviceVerificationFromSummaries\(initialServiceConnectionSummaries\)/,
    );
    expect(editor).not.toContain("INITIAL_SERVICE_VERIFICATION");

    const summaries = loadDurableServiceConnectionSummaries({
      LINEAR_API_KEY: true,
      CURSOR_API_KEY: true,
      GITHUB_TOKEN: false,
      VERCEL_TOKEN: false,
    });
    const seeded = serviceVerificationFromSummaries(summaries);

    expect(
      resolveServiceConnectionBadgeState(
        true,
        seeded.LINEAR_API_KEY,
        "",
      ),
    ).toBe("checking");
    expect(
      resolveServiceConnectionBadgeState(
        false,
        seeded.GITHUB_TOKEN,
        "",
      ),
    ).toBe("missing");
  });
});

describe("Data sharing dirty save state", () => {
  it("tracks baseline and dirty state for settings save gating", () => {
    const source = readSource(
      "apps/gui/components/custom/data-sharing-preferences.tsx",
    );

    expect(source).toContain("baselineEnabled");
    expect(source).toContain("const isDirty = checked !== baselineEnabled");
    expect(source).toContain('mode === "settings" && !isDirty');
    expect(source).toContain("setBaselineEnabled(nextChecked)");

    const enabledBaseline = isUnifiedDataSharingEnabled({
      analyticsPreference: "enabled",
      errorReportingPreference: "enabled",
      disclosureShown: true,
    });
    const disabledBaseline = isUnifiedDataSharingEnabled({
      analyticsPreference: "disabled",
      errorReportingPreference: "disabled",
      disclosureShown: true,
    });
    expect(enabledBaseline).toBe(true);
    expect(disabledBaseline).toBe(false);
    expect(enabledBaseline === disabledBaseline).toBe(false);
  });
});

describe("Linear full team name display", () => {
  it("formats team labels with teamName primarily", () => {
    expect(
      formatLinearTeamLabel({
        teamName: "fresh p-dev linear team",
        teamKey: "FRE",
      }),
    ).toBe("fresh p-dev linear team (FRE)");
    expect(
      formatLinearTeamLabel({
        teamName: "FRE",
        teamKey: "FRE",
      }),
    ).toBe("FRE");
    expect(
      formatLinearTeamLabel({
        teamKey: "FRE",
      }),
    ).toBe("FRE");
  });

  it("uses formatLinearTeamLabel in settings and guided configured lists", () => {
    const settings = readSource(
      "apps/gui/components/settings/editors/linear-settings-editor.tsx",
    );
    const guided = readSource(
      "apps/gui/components/custom/guided-linear-workspace-card.tsx",
    );

    expect(settings).toContain("formatLinearTeamLabel");
    expect(settings).toContain("teamName: teamAssociations[0]?.teamName");
    expect(guided).toContain("formatLinearTeamLabel");
    expect(guided).not.toMatch(/\{associations\[0\]\?\.teamKey\} ·/);
  });
});

describe("GuidedSelect height usage in settings", () => {
  it("uses GuidedSelect instead of local selectClassName strings", () => {
    const deployments = readSource(
      "apps/gui/components/settings/editors/deployments-settings-editor.tsx",
    );
    const linear = readSource(
      "apps/gui/components/settings/editors/linear-settings-editor.tsx",
    );
    const modelControl = readSource(
      "apps/gui/components/workflow/workflow-model-control.tsx",
    );

    const linearProvision = readSource(
      "apps/gui/components/settings/linear-provision-form.tsx",
    );

    expect(deployments).not.toContain("GuidedSelect");
    expect(deployments).not.toContain("selectClassName");
    expect(linearProvision).toContain("GuidedSelect");
    expect(linearProvision).not.toContain("selectClassName");
    expect(linear).not.toContain("selectClassName");
    expect(modelControl).toContain("GuidedSelect");
    expect(modelControl).not.toMatch(
      /className="rounded-md border border-input bg-background px-2 py-1\.5 text-sm"/,
    );
  });
});
