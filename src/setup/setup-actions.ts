import { mkdir } from "node:fs/promises";
import type { SetupPermission } from "./permission-model.js";
import { SETUP_PERMISSIONS } from "./permission-model.js";
import {
  scaffoldConfigFromExample,
  writeConfigLocal,
} from "./config-writer.js";
import { scaffoldEnvFromExample, writeEnvLocal } from "./env-writer.js";
import {
  generateGitHubSecretInstructions,
  generateHarnessConfigB64Instructions,
} from "./generated-instructions.js";
import {
  REMOTE_SETUP_ACTIONS,
} from "./remote-actions.js";
import {
  resolveLocalFilePaths,
  type SetupActionOutcome,
  type SetupExecutionMode,
  type SetupScaffoldOptions,
} from "./setup-state.js";

export interface SetupActionResult {
  actionId: string;
  outcome: SetupActionOutcome;
  targetPath?: string;
  content?: string;
  reason?: string;
  permission: SetupPermission;
  manualInstructions?: string[];
  logMessage?: string;
}

export interface SetupActionDescriptor {
  id: string;
  label: string;
  description: string;
  permission: SetupPermission;
}

export const SETUP_ACTIONS = {
  scaffoldEnvLocal: {
    id: "scaffold-env-local",
    label: "Scaffold .env.local",
    description: "Create or update local environment file from committed example",
    permission: SETUP_PERMISSIONS.localFileWrite,
  },
  scaffoldConfigLocal: {
    id: "scaffold-config-local",
    label: "Scaffold .harness/config.local.json",
    description:
      "Create or update private harness config from committed example",
    permission: SETUP_PERMISSIONS.localFileWrite,
  },
  generateHarnessConfigB64Instructions: {
    id: "generate-harness-config-b64-instructions",
    label: "Generate HARNESS_CONFIG_JSON_B64 instructions",
    description: "Produce manual copy-paste steps for GitHub Actions config secret",
    permission: SETUP_PERMISSIONS.readOnly,
  },
  generateGitHubSecretInstructions: {
    id: "generate-github-secret-instructions",
    label: "Generate GitHub Actions secret instructions",
    description: "Produce manual copy-paste steps for harness repo secrets",
    permission: SETUP_PERMISSIONS.readOnly,
  },
  applyHarnessSecrets: {
    id: REMOTE_SETUP_ACTIONS.applyHarnessSecrets.id,
    label: REMOTE_SETUP_ACTIONS.applyHarnessSecrets.label,
    description: REMOTE_SETUP_ACTIONS.applyHarnessSecrets.description,
    permission: REMOTE_SETUP_ACTIONS.applyHarnessSecrets.permission,
  },
  futureSetGitHubSecrets: {
    id: REMOTE_SETUP_ACTIONS.applyHarnessSecrets.id,
    label: REMOTE_SETUP_ACTIONS.applyHarnessSecrets.label,
    description: REMOTE_SETUP_ACTIONS.applyHarnessSecrets.description,
    permission: REMOTE_SETUP_ACTIONS.applyHarnessSecrets.permission,
  },
  previewHarnessSecrets: {
    id: REMOTE_SETUP_ACTIONS.previewHarnessSecrets.id,
    label: REMOTE_SETUP_ACTIONS.previewHarnessSecrets.label,
    description: REMOTE_SETUP_ACTIONS.previewHarnessSecrets.description,
    permission: REMOTE_SETUP_ACTIONS.previewHarnessSecrets.permission,
  },
  previewTargetWorkflowPr: {
    id: REMOTE_SETUP_ACTIONS.previewTargetWorkflowPr.id,
    label: REMOTE_SETUP_ACTIONS.previewTargetWorkflowPr.label,
    description: REMOTE_SETUP_ACTIONS.previewTargetWorkflowPr.description,
    permission: REMOTE_SETUP_ACTIONS.previewTargetWorkflowPr.permission,
  },
  applyTargetWorkflowPr: {
    id: REMOTE_SETUP_ACTIONS.applyTargetWorkflowPr.id,
    label: REMOTE_SETUP_ACTIONS.applyTargetWorkflowPr.label,
    description: REMOTE_SETUP_ACTIONS.applyTargetWorkflowPr.description,
    permission: REMOTE_SETUP_ACTIONS.applyTargetWorkflowPr.permission,
  },
} as const satisfies Record<string, SetupActionDescriptor>;

export interface OperatorScaffoldResult {
  results: SetupActionResult[];
  logMessages: string[];
}

function resolveMode(options?: SetupScaffoldOptions): SetupExecutionMode {
  return options?.mode ?? "apply";
}

export async function runOperatorScaffold(
  options?: SetupScaffoldOptions,
): Promise<OperatorScaffoldResult> {
  const paths = resolveLocalFilePaths(options?.cwd);
  const force = options?.force ?? false;
  const mode = resolveMode(options);
  const results: SetupActionResult[] = [];
  const logMessages: string[] = [];

  if (mode === "apply") {
    await mkdir(paths.harnessDir, { recursive: true });
  }

  const envResult = await scaffoldEnvFromExample({
    paths,
    force,
    mode,
  });
  results.push(envResult);
  if (envResult.logMessage) {
    logMessages.push(envResult.logMessage);
  }

  const configResult = await scaffoldConfigFromExample({
    paths,
    force,
    mode,
  });
  results.push(configResult);
  if (configResult.logMessage) {
    logMessages.push(configResult.logMessage);
  }

  return { results, logMessages };
}

export function previewHarnessConfigB64Instructions(options?: {
  configPath?: string;
}): SetupActionResult {
  const instructions = generateHarnessConfigB64Instructions(options);
  return {
    actionId: SETUP_ACTIONS.generateHarnessConfigB64Instructions.id,
    outcome: "preview",
    permission: SETUP_ACTIONS.generateHarnessConfigB64Instructions.permission,
    manualInstructions: instructions.steps,
    content: instructions.command,
    reason: instructions.summary,
  };
}

export function previewGitHubSecretInstructions(options?: {
  harnessRepo?: string;
}): SetupActionResult {
  const instructions = generateGitHubSecretInstructions(options);
  return {
    actionId: SETUP_ACTIONS.generateGitHubSecretInstructions.id,
    outcome: "preview",
    permission: SETUP_ACTIONS.generateGitHubSecretInstructions.permission,
    manualInstructions: instructions.steps,
    reason: instructions.summary,
  };
}

export function describeDeferredRemoteHarnessSecretWrite(): SetupActionResult {
  const instructions = generateGitHubSecretInstructions();
  return {
    actionId: SETUP_ACTIONS.futureSetGitHubSecrets.id,
    outcome: "preview",
    permission: SETUP_ACTIONS.futureSetGitHubSecrets.permission,
    manualInstructions: instructions.steps,
    reason:
      "Remote secret writes are previewable in setup core. GUI apply remains deferred to Milestone 5 PR 2.",
  };
}

export { writeConfigLocal, writeEnvLocal };
