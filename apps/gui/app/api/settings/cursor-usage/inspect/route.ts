import { NextRequest, NextResponse } from "next/server";
import {
  CURSOR_USAGE_UPLOAD_MAX_BYTES,
  guardCursorUsageMultipartUpload,
} from "@/lib/cursor-usage-request-guard";
import { runCursorUsageInspect } from "@/lib/cursor-usage-server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await guardCursorUsageMultipartUpload(request);
  if (!guard.ok) {
    return guard.response;
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart form." }, { status: 400 });
  }

  const file = formData.get("file");
  const assumedTimezone = String(formData.get("assumedTimezone") ?? "").trim();
  const disambiguation = String(formData.get("disambiguation") ?? "").trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "CSV file is required." }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return NextResponse.json(
      { error: "CSV filename required." },
      { status: 400 },
    );
  }
  if (file.size > CURSOR_USAGE_UPLOAD_MAX_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const csvBytes = Buffer.from(await file.arrayBuffer());
  try {
    const result = runCursorUsageInspect({
      csvBytes,
      assumedTimezone: assumedTimezone || null,
      disambiguation:
        disambiguation === "earlier" || disambiguation === "later"
          ? disambiguation
          : "reject_ambiguous",
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Inspection failed.";
    if (message === "invalid_assumed_timezone") {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    if (message.startsWith("Missing required CSV column")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
