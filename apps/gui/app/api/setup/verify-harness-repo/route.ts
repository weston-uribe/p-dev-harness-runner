import { NextResponse } from "next/server";
import { verifyHarnessRepoAccessRemote } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      harnessDispatchRepo?: string;
      githubToken?: string;
    };

    if (!body.harnessDispatchRepo?.trim()) {
      return NextResponse.json(
        { error: "A harness repo slug or URL is required." },
        { status: 400 },
      );
    }

    const result = await verifyHarnessRepoAccessRemote({
      harnessDispatchRepo: body.harnessDispatchRepo,
      githubToken: body.githubToken,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Harness repo verification failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
