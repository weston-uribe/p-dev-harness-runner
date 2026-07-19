import type { FirstRunStepId } from "@harness/setup/first-run-readiness";
import type { FirstRunStep } from "@harness/setup/first-run-readiness";
import type { ControlPlaneReadinessContext } from "@harness/setup/control-plane-types";
import type { SetupGuiViewModel } from "@/lib/setup-server";

/** Number of guided setup steps before the "Ready for first run" completion state. */
export const GUIDED_SETUP_STEP_COUNT = 7;

const FIRST_RUN_STEP_ORDER: readonly FirstRunStepId[] = [
  "connect-services",
  "linear-workspace",
  "vercel-bridge",
  "local-setup",
  "local-readiness",
  "cloud-secrets",
  "target-workflow",
  "ready-for-first-run",
] as const;

/** Sub-steps within guided local setup workflow. */
export type GuidedLocalSetupStep = "connect-services" | "choose-target-repos";

/** Every screen the guided configure flow can display, including completion. */
export type GuidedDisplayStepId =
  | "connect-services"
  | "linear-workspace"
  | "vercel-bridge"
  | GuidedLocalSetupStep
  | "local-readiness"
  | "cloud-secrets"
  | "target-workflow"
  | "ready-for-first-run";

export const GUIDED_DISPLAY_STEP_ORDER: readonly GuidedDisplayStepId[] = [
  "connect-services",
  "linear-workspace",
  "vercel-bridge",
  "choose-target-repos",
  "local-readiness",
  "cloud-secrets",
  "target-workflow",
  "ready-for-first-run",
] as const;

/** Display-only progress stages shown in guided mode (excludes completion screen). */
export type GuidedProgressStageId = Exclude<
  GuidedDisplayStepId,
  "ready-for-first-run"
>;

export type GuidedProgressStageState = "completed" | "current" | "upcoming";

export interface GuidedProgressStageMetadata {
  id: GuidedProgressStageId;
  shortLabel: string;
  accessibleLabel: string;
}

export interface GuidedProgressStage extends GuidedProgressStageMetadata {
  state: GuidedProgressStageState;
  stepNumber: number;
}

export const GUIDED_PROGRESS_STAGES: readonly GuidedProgressStageMetadata[] = [
  {
    id: "connect-services",
    shortLabel: "Services",
    accessibleLabel: "Connect services",
  },
  {
    id: "linear-workspace",
    shortLabel: "Linear",
    accessibleLabel: "Set up Linear workspace",
  },
  {
    id: "vercel-bridge",
    shortLabel: "Bridge",
    accessibleLabel: "Set up PDev automation bridge",
  },
  {
    id: "choose-target-repos",
    shortLabel: "Repositories",
    accessibleLabel: "Choose target repositories",
  },
  {
    id: "local-readiness",
    shortLabel: "Readiness",
    accessibleLabel: "Check local readiness",
  },
  {
    id: "cloud-secrets",
    shortLabel: "Secrets",
    accessibleLabel: "Connect cloud secrets",
  },
  {
    id: "target-workflow",
    shortLabel: "Workflow",
    accessibleLabel: "Install target workflow",
  },
] as const;

export function firstRunStepIdForProgressStage(
  stageId: GuidedProgressStageId,
): FirstRunStepId {
  if (stageId === "choose-target-repos") {
    return "local-setup";
  }
  return stageId;
}

export function progressStageForFirstRunStepId(
  stepId: FirstRunStepId,
): GuidedProgressStageId | "ready-for-first-run" {
  if (stepId === "local-setup") {
    return "choose-target-repos";
  }
  if (stepId === "ready-for-first-run") {
    return "ready-for-first-run";
  }
  return stepId;
}

export function progressStageForDisplayStep(
  step: GuidedDisplayStepId,
): GuidedProgressStageId | null {
  if (step === "ready-for-first-run") {
    return null;
  }
  return step;
}

function isLinearWorkspaceDurablelyComplete(
  context?: ControlPlaneReadinessContext,
): boolean {
  const linear = context?.state?.linear;
  if (!linear?.teamKey) {
    return false;
  }
  return linear.statusCoverageComplete || linear.manualComplete === true;
}

function isVercelBridgeDurablelyComplete(
  context?: ControlPlaneReadinessContext,
): boolean {
  return Boolean(context?.state?.vercel?.projectId);
}

function isProgressStageDurablelyComplete(
  stageId: GuidedProgressStageId,
  input: {
    summary?: SetupGuiViewModel;
    controlPlaneContext?: ControlPlaneReadinessContext;
  },
): boolean {
  switch (stageId) {
    case "connect-services":
      return input.summary ? connectServicesComplete(input.summary) : false;
    case "linear-workspace":
      return isLinearWorkspaceDurablelyComplete(input.controlPlaneContext);
    case "vercel-bridge":
      return isVercelBridgeDurablelyComplete(input.controlPlaneContext);
    case "choose-target-repos":
      return input.summary?.overview.localFilesPresent === true;
    default:
      return false;
  }
}

function isProgressStageObjectivelyComplete(
  stageId: GuidedProgressStageId,
  input: {
    readinessCurrentStepId: FirstRunStepId;
    readinessSteps: readonly FirstRunStep[];
    readyForFirstRun: boolean;
    summary?: SetupGuiViewModel;
    controlPlaneContext?: ControlPlaneReadinessContext;
  },
): boolean {
  if (input.readyForFirstRun) {
    return true;
  }

  if (
    isProgressStageDurablelyComplete(stageId, {
      summary: input.summary,
      controlPlaneContext: input.controlPlaneContext,
    })
  ) {
    return true;
  }

  const mappedStepId = firstRunStepIdForProgressStage(stageId);
  const readinessStep = input.readinessSteps.find(
    (step) => step.id === mappedStepId,
  );

  if (readinessStep?.status === "complete") {
    return true;
  }

  return compareFirstRunStepIds(input.readinessCurrentStepId, mappedStepId) > 0;
}

export function deriveGuidedProgressStages(input: {
  displayedStep: GuidedDisplayStepId;
  readinessCurrentStepId: FirstRunStepId;
  readinessSteps: readonly FirstRunStep[];
  readyForFirstRun: boolean;
  summary?: SetupGuiViewModel;
  controlPlaneContext?: ControlPlaneReadinessContext;
}): GuidedProgressStage[] {
  const displayStageId = progressStageForDisplayStep(input.displayedStep);
  const allComplete =
    input.readyForFirstRun || input.displayedStep === "ready-for-first-run";

  return GUIDED_PROGRESS_STAGES.map((stage, index) => {
    const objectivelyComplete = isProgressStageObjectivelyComplete(stage.id, {
      readinessCurrentStepId: input.readinessCurrentStepId,
      readinessSteps: input.readinessSteps,
      readyForFirstRun: input.readyForFirstRun,
      summary: input.summary,
      controlPlaneContext: input.controlPlaneContext,
    });
    const isDisplayCurrent = !allComplete && displayStageId === stage.id;

    let state: GuidedProgressStageState;
    if (allComplete) {
      state = "completed";
    } else if (isDisplayCurrent) {
      state = "current";
    } else if (objectivelyComplete) {
      state = "completed";
    } else {
      state = "upcoming";
    }

    return {
      ...stage,
      state,
      stepNumber: index + 1,
    };
  });
}

export function guidedDisplayStepIndex(step: GuidedDisplayStepId): number {
  return GUIDED_DISPLAY_STEP_ORDER.indexOf(step);
}

export function getPreviousGuidedDisplayStep(
  step: GuidedDisplayStepId,
): GuidedDisplayStepId | null {
  const index = guidedDisplayStepIndex(step);
  if (index <= 0) {
    return null;
  }
  return GUIDED_DISPLAY_STEP_ORDER[index - 1] ?? null;
}

export function maxGuidedDisplayStepForReadiness(
  currentStepId: FirstRunStepId,
): GuidedDisplayStepId {
  switch (currentStepId) {
    case "connect-services":
      return "connect-services";
    case "linear-workspace":
      return "linear-workspace";
    case "vercel-bridge":
      return "vercel-bridge";
    case "local-setup":
      return "choose-target-repos";
    case "local-readiness":
      return "local-readiness";
    case "cloud-secrets":
      return "cloud-secrets";
    case "target-workflow":
      return "target-workflow";
    case "ready-for-first-run":
      return "ready-for-first-run";
  }
}

function localServiceKeysConfigured(summary: SetupGuiViewModel): boolean {
  return (
    summary.envKeyPresence.LINEAR_API_KEY &&
    summary.envKeyPresence.CURSOR_API_KEY &&
    summary.envKeyPresence.GITHUB_TOKEN &&
    summary.envKeyPresence.VERCEL_TOKEN
  );
}

function localEnvFileExists(summary: SetupGuiViewModel): boolean {
  return summary.localFiles.find((file) => file.label === ".env.local")?.exists ?? false;
}

export function localSetupFilesExist(summary: SetupGuiViewModel): boolean {
  return summary.overview.localFilesPresent;
}

/** Guided display step after Step 4 local file apply succeeds (first apply or update). */
export const GUIDED_DISPLAY_STEP_AFTER_LOCAL_APPLY: GuidedDisplayStepId =
  "local-readiness";

/** Guided display step when all target workflows are installed on production. */
export const GUIDED_DISPLAY_STEP_AFTER_WORKFLOW_READY: GuidedDisplayStepId =
  "ready-for-first-run";

/** Guided display step after service keys are saved in Step 1. */
export const GUIDED_DISPLAY_STEP_AFTER_CONNECT_SERVICES: GuidedDisplayStepId =
  "linear-workspace";

/** Guided display step after local readiness is reviewed in Step 5. */
export const GUIDED_DISPLAY_STEP_AFTER_LOCAL_READINESS: GuidedDisplayStepId =
  "cloud-secrets";

/** Guided display step after cloud secrets are verified and reviewed in Step 6. */
export const GUIDED_DISPLAY_STEP_AFTER_CLOUD_SECRETS: GuidedDisplayStepId =
  "target-workflow";

/**
 * Default guided screen after mount or when readiness advances forward.
 * Does not resurrect a manually visited earlier sub-step from browser/session storage.
 */
export function defaultGuidedDisplayStep(input: {
  currentStepId: FirstRunStepId;
  summary: SetupGuiViewModel;
}): GuidedDisplayStepId {
  switch (input.currentStepId) {
    case "connect-services":
      return "connect-services";
    case "linear-workspace":
      return "linear-workspace";
    case "vercel-bridge":
      return "vercel-bridge";
    case "local-setup":
      return localEnvFileExists(input.summary) && localSetupFilesExist(input.summary)
        ? "choose-target-repos"
        : "choose-target-repos";
    case "local-readiness":
      return "local-readiness";
    case "cloud-secrets":
      return "cloud-secrets";
    case "target-workflow":
      return "target-workflow";
    case "ready-for-first-run":
      return "ready-for-first-run";
  }
}

export function isGuidedLocalSetupStep(
  step: GuidedDisplayStepId,
): step is GuidedLocalSetupStep {
  return step === "connect-services" || step === "choose-target-repos";
}

export function shouldShowGuidedBackButton(step: GuidedDisplayStepId): boolean {
  return getPreviousGuidedDisplayStep(step) !== null;
}

export function compareGuidedDisplaySteps(
  left: GuidedDisplayStepId,
  right: GuidedDisplayStepId,
): number {
  return guidedDisplayStepIndex(left) - guidedDisplayStepIndex(right);
}

export type GuidedTransitionDirection = "forward" | "backward" | "none";

export function getGuidedTransitionDirection(
  previous: GuidedDisplayStepId | null,
  next: GuidedDisplayStepId,
): GuidedTransitionDirection {
  if (previous === null || previous === next) {
    return "none";
  }

  const comparison = compareGuidedDisplaySteps(previous, next);
  if (comparison < 0) {
    return "forward";
  }
  if (comparison > 0) {
    return "backward";
  }
  return "none";
}

export function compareFirstRunStepIds(
  left: FirstRunStepId,
  right: FirstRunStepId,
): number {
  return FIRST_RUN_STEP_ORDER.indexOf(left) - FIRST_RUN_STEP_ORDER.indexOf(right);
}

export function readinessStepAdvanced(
  next: FirstRunStepId,
  previous: FirstRunStepId,
): boolean {
  return compareFirstRunStepIds(next, previous) > 0;
}

/**
 * Whether readiness moving forward should update the guided display step.
 * Step 1 must not auto-advance to Linear workspace when keys become complete;
 * the user clicks Continue instead.
 */
export function shouldReadinessAdvanceGuidedDisplay(
  previous: FirstRunStepId,
  next: FirstRunStepId,
): boolean {
  if (
    previous === "connect-services" &&
    next === "linear-workspace"
  ) {
    return false;
  }
  return readinessStepAdvanced(next, previous);
}

export function isGuidedDisplayStepAllowed(
  target: GuidedDisplayStepId,
  currentStepId: FirstRunStepId,
): boolean {
  const maxAllowed = maxGuidedDisplayStepForReadiness(currentStepId);
  return compareGuidedDisplaySteps(target, maxAllowed) <= 0;
}

export function clampGuidedDisplayStep(input: {
  target: GuidedDisplayStepId;
  currentStepId: FirstRunStepId;
}): GuidedDisplayStepId {
  const maxAllowed = maxGuidedDisplayStepForReadiness(input.currentStepId);
  return compareGuidedDisplaySteps(input.target, maxAllowed) > 0
    ? maxAllowed
    : input.target;
}

export function connectServicesComplete(summary: SetupGuiViewModel): boolean {
  return localServiceKeysConfigured(summary);
}
