import { NextResponse } from "next/server";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";
import { verifySetupService } from "@harness/setup/service-verification";
import type { SetupServiceName } from "@harness/setup/service-verification";

export const dynamic = "force-dynamic";

const ALLOWED_SERVICES = new Set<SetupServiceName>([
  "linear",
  "cursor",
  "github",
  "vercel",
]);

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      service?: SetupServiceName;
      token?: string;
    };

    if (!body.service || !ALLOWED_SERVICES.has(body.service)) {
      return NextResponse.json(
        { error: "A valid service is required: linear, cursor, github, or vercel." },
        { status: 400 },
      );
    }

    const result = await verifySetupService({
      cwd: resolveHarnessWorkspaceDir(),
      service: body.service,
      token: body.token,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Service verification failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
