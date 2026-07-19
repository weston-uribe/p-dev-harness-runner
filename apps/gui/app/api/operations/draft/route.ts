import { NextResponse } from "next/server";

export async function PUT() {
  return NextResponse.json(
    { saved: false, error: "Operations draft API is retired. Use /api/workflow/models." },
    { status: 410 },
  );
}

export async function DELETE() {
  return NextResponse.json(
    { error: "Operations draft API is retired." },
    { status: 410 },
  );
}
