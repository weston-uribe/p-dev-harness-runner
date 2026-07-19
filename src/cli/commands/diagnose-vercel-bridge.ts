import { buildVercelBridgeDiagnosticReport } from "../../setup/vercel-bridge-diagnostics.js";

export async function runDiagnoseVercelBridgeCommand(options: {
  cwd?: string;
  liveProbe?: boolean;
}): Promise<number> {
  try {
    const report = await buildVercelBridgeDiagnosticReport({
      cwd: options.cwd,
      liveProbe: options.liveProbe === true,
    });
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Vercel bridge diagnostics failed.",
      }),
    );
    return 1;
  }
}
