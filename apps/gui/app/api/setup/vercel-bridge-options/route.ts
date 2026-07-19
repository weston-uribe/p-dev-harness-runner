import { NextResponse } from "next/server";
import {
  loadVercelBridgeOptionsRemote,
  loadVercelBridgeProjectsRemote,
} from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const teamId = url.searchParams.get("teamId") ?? undefined;
    const projectsOnly = url.searchParams.get("projectsOnly") === "true";

    if (projectsOnly) {
      const projects = await loadVercelBridgeProjectsRemote(teamId);
      return NextResponse.json({ projects });
    }

    const options = await loadVercelBridgeOptionsRemote({ teamId });
    return NextResponse.json(options);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load Vercel bridge options";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
