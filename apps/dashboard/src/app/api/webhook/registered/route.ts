import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Native public.users INSERT + reconciliation own this lifecycle. Retiring the
// external webhook also prevents legacy replays from creating duplicate mail.
export async function POST() {
  return NextResponse.json(
    {
      message:
        "Registration onboarding is handled by the local database worker.",
    },
    { status: 410 },
  );
}
