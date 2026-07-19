import { runLocalReadinessChecksProgress } from "@harness/setup/local-readiness-checks";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";

export const dynamic = "force-dynamic";

function wantsNdjsonStream(request: Request): boolean {
  const url = new URL(request.url);
  if (url.searchParams.get("stream") === "1") {
    return true;
  }
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/x-ndjson");
}

export async function GET(request: Request): Promise<Response> {
  const cwd = resolveHarnessWorkspaceDir();

  if (!wantsNdjsonStream(request)) {
    try {
      const { runLocalReadinessChecks } = await import(
        "@harness/setup/local-readiness-checks"
      );
      const result = await runLocalReadinessChecks({ cwd });
      return Response.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Local readiness check failed";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runLocalReadinessChecksProgress({ cwd })) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          if (event.type === "run-completed" || event.type === "run-failed") {
            break;
          }
        }
        controller.close();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Local readiness check failed";
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ type: "run-failed", message })}\n`),
        );
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
