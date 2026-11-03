import { NextResponse } from "next/server";
export function GET() {
  return NextResponse.json(
    {
      error: "DESKTOP_NOT_AVAILABLE",
      message:
        "A signed AGSaaS desktop release is not available for either Apple Silicon or Intel. Use the web workspace.",
      help: "/download",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
