import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = new URL("/api/workflow/bootstrap", url.origin);
  target.search = url.search;
  return NextResponse.redirect(target, 307);
}
