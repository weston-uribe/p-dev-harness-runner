import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LinearIssueSnapshot } from "../linear/client.js";
import { getIssueSnapshotPath } from "./paths.js";

export async function writeIssueSnapshot(
  runDirectory: string,
  snapshot: LinearIssueSnapshot,
): Promise<void> {
  const snapshotPath = getIssueSnapshotPath(runDirectory);
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}
