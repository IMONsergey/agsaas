export function POST() {
  return Response.json(
    {
      error: "DOCS_ASSISTANT_NOT_CONFIGURED",
      message:
        "Use the searchable documentation or contact your workspace administrator.",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
