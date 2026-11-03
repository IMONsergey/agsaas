export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "website",
      version:
        process.env.GIT_COMMIT_SHA ??
        process.env.NEXT_PUBLIC_RELEASE_SHA ??
        "unknown",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
