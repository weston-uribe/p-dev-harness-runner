import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  probePassedGoGate,
  runCursorSdkUsageProbe,
} from "../../evaluation/cursor-sdk-usage-probe/run.js";

export async function runEvaluationProbeCursorSdkUsage(options: {
  targetRepo?: string;
  startingRef?: string;
  includeLocal?: boolean;
  out?: string;
  publicOut?: string;
  json?: boolean;
  publicOnly?: boolean;
}): Promise<number> {
  try {
    const report = await runCursorSdkUsageProbe({
      targetRepo: options.targetRepo,
      startingRef: options.startingRef,
      includeLocal: options.includeLocal === true,
    });

    if (options.out) {
      await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
      await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    if (options.publicOut) {
      await mkdir(path.dirname(path.resolve(options.publicOut)), {
        recursive: true,
      });
      await writeFile(
        options.publicOut,
        `${JSON.stringify(report.publicSummary, null, 2)}\n`,
        "utf8",
      );
    }

    if (options.publicOnly) {
      console.log(JSON.stringify(report.publicSummary, null, 2));
    } else if (options.json !== false) {
      // Private report to stdout for maintainer local runs only.
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(JSON.stringify(report.publicSummary, null, 2));
    }

    if (!probePassedGoGate(report)) {
      console.error(
        `cursor-sdk-usage-probe go/no-go: no-go — ${report.cloud.goNoGoReason}`,
      );
      return 2;
    }
    console.error("cursor-sdk-usage-probe go/no-go: go");
    return 0;
  } catch (err) {
    console.error(
      `evaluation:probe-cursor-sdk-usage failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }
}
