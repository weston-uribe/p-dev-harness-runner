import type { IssueValidationResult } from "./types.js";

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatIntendedPhase(phase: IssueValidationResult["intendedPhase"]): string {
  return phase ?? "none";
}

function formatPassesIntendedPhase(result: IssueValidationResult): string {
  if (result.passesIntendedPhase === null) {
    return "n/a";
  }
  return yesNo(result.passesIntendedPhase);
}

function formatPlanningMarker(result: IssueValidationResult): string {
  if (result.planningMarkerMode === "file") {
    return "n/a";
  }
  return yesNo(result.hasPlanningMarker);
}

export function formatValidationReport(result: IssueValidationResult): string {
  const lines: string[] = [
    "# Issue Validation Report",
    "",
    `- Valid for planning: ${yesNo(result.validForPlanning)}`,
    `- Valid for direct implementation: ${yesNo(result.validForDirectImplementation)}`,
    `- Intended phase: ${formatIntendedPhase(result.intendedPhase)}`,
    `- Passes intended phase: ${formatPassesIntendedPhase(result)}`,
    `- Target repo: ${result.targetRepo ?? "unresolved"}`,
    `- Resolution source: ${result.resolutionSource ?? "—"}`,
    `- Narrow issue (build-direct heuristic): ${yesNo(result.narrowIssue)}`,
    `- Planning marker present: ${formatPlanningMarker(result)}`,
    "",
    "## Parser errors",
  ];

  if (result.parseErrors.length === 0) {
    lines.push("_none_");
  } else {
    for (const error of result.parseErrors) {
      lines.push(`- ${error}`);
    }
  }

  lines.push("", "## Routing / status notes");
  if (result.routingNotes.length === 0) {
    lines.push("_none_");
  } else {
    for (const note of result.routingNotes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("", "## Repair instructions");
  if (result.repairInstructions.length === 0) {
    lines.push("_none_");
  } else {
    for (const instruction of result.repairInstructions) {
      lines.push(`- ${instruction}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
