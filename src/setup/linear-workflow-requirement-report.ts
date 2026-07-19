/**
 * Provider-neutral Linear workflow status requirement report (dry-run only).
 * Does not create or modify live Linear statuses.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "../config/types.js";
import { migrateWorkflowConfigSection } from "../config/migrate-workflow-config.js";
import {
  resolveWorkflowDefinition,
  requiredLinearStatusNames,
} from "../workflow/definition/resolve.js";
import type { ResolvedWorkflowDefinition } from "../workflow/definition/types.js";
import {
  createLinearSetupClient,
  listTeamWorkflowStates,
  type LinearWorkflowStateSummary,
} from "./linear-setup-client.js";

export interface WorkflowStatusRequirementEntry {
  requiredName: string;
  requiredCategory: string;
  present: boolean;
  existingName?: string;
  existingType?: string;
  existingStatusId?: string;
  categoryMatches: boolean;
  action: "ok" | "create" | "repair_category" | "map";
  optionalPhaseId?: string;
}

export interface LinearWorkflowRequirementReport {
  dryRun: true;
  generatedAt: string;
  workflowSchemaVersion: string;
  teamId: string;
  teamKey?: string;
  enabledOptionalPhases: Readonly<Record<string, boolean>>;
  required: WorkflowStatusRequirementEntry[];
  missing: string[];
  extra: string[];
  categoryMismatches: string[];
  proposedAdditions: string[];
  proposedMappings: Array<{ required: string; existing: string }>;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export function buildLinearWorkflowRequirementReport(input: {
  definition: ResolvedWorkflowDefinition;
  teamId: string;
  teamKey?: string;
  existingStates: readonly LinearWorkflowStateSummary[];
}): LinearWorkflowRequirementReport {
  const requiredNames = requiredLinearStatusNames(input.definition);
  const requiredStatuses = input.definition.statuses.filter((s) =>
    requiredNames.includes(s.name),
  );
  const existingByName = new Map(
    input.existingStates.map((s) => [normalize(s.name), s]),
  );
  const requiredNormalized = new Set(requiredNames.map(normalize));

  const required: WorkflowStatusRequirementEntry[] = requiredStatuses.map(
    (status) => {
      const existing = existingByName.get(normalize(status.name));
      if (!existing) {
        return {
          requiredName: status.name,
          requiredCategory: status.category,
          present: false,
          categoryMatches: false,
          action: "create" as const,
          optionalPhaseId: status.optionalPhaseId,
        };
      }
      const categoryMatches =
        existing.type.trim().toLowerCase() === status.category;
      return {
        requiredName: status.name,
        requiredCategory: status.category,
        present: true,
        existingName: existing.name,
        existingType: existing.type,
        existingStatusId: existing.id,
        categoryMatches,
        action: categoryMatches ? ("ok" as const) : ("repair_category" as const),
        optionalPhaseId: status.optionalPhaseId,
      };
    },
  );

  const missing = required.filter((r) => !r.present).map((r) => r.requiredName);
  const categoryMismatches = required
    .filter((r) => r.present && !r.categoryMatches)
    .map((r) => r.requiredName);
  const extra = input.existingStates
    .filter((s) => !requiredNormalized.has(normalize(s.name)))
    .map((s) => s.name);

  return {
    dryRun: true,
    generatedAt: new Date().toISOString(),
    workflowSchemaVersion: input.definition.schemaVersion,
    teamId: input.teamId,
    teamKey: input.teamKey,
    enabledOptionalPhases: input.definition.enabledOptionalPhases,
    required,
    missing,
    extra,
    categoryMismatches,
    proposedAdditions: missing,
    proposedMappings: [],
  };
}

export async function generateLinearWorkflowRequirementReport(input: {
  config: HarnessConfig;
  linearApiKey: string;
  teamId: string;
  teamKey?: string;
  baseBranch?: string;
  productionBranch?: string;
  outputPath?: string;
}): Promise<LinearWorkflowRequirementReport> {
  const workflowConfig = migrateWorkflowConfigSection(input.config);
  const definition = resolveWorkflowDefinition({
    workflowConfig,
    baseBranch: input.baseBranch,
    productionBranch: input.productionBranch,
  });

  const client = createLinearSetupClient(input.linearApiKey);
  const existingStates = await listTeamWorkflowStates(client, input.teamId);
  const report = buildLinearWorkflowRequirementReport({
    definition,
    teamId: input.teamId,
    teamKey: input.teamKey,
    existingStates,
  });

  if (input.outputPath) {
    await mkdir(path.dirname(input.outputPath), { recursive: true });
    await writeFile(
      input.outputPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }

  return report;
}
