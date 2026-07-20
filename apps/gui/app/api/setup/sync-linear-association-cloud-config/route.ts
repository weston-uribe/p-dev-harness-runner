import { NextResponse } from "next/server";
import { syncLinearAssociationCloudConfigRemote } from "@/lib/setup-server";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await syncLinearAssociationCloudConfigRemote();
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Cloud harness config sync failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
