import { mkdir, writeFile } from "node:fs/promises";
import { getSubjectExtractionReportPath } from "../../artifacts/paths.js";
import type { SubjectExtractionReport } from "./types.js";

export async function writeSubjectExtractionReport(
  evaluationDirectory: string,
  report: SubjectExtractionReport,
): Promise<string> {
  await mkdir(evaluationDirectory, { recursive: true });
  const filePath = getSubjectExtractionReportPath(evaluationDirectory);
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return filePath;
}
