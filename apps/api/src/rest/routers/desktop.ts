import { OpenAPIHono } from "@hono/zod-openapi";
// This installation does not publish signed desktop artifacts. Never send its
// release token to the upstream project or silently install another product.
export const desktopRouter = new OpenAPIHono();
desktopRouter.get("/update", (c) =>
  c.json(
    {
      error: "DESKTOP_NOT_CONFIGURED",
      message:
        "AGSaaS desktop distribution is not configured. Use this installation's web application.",
    },
    503,
    { "Cache-Control": "no-store" },
  ),
);
desktopRouter.get("/update/download", (c) =>
  c.json(
    {
      error: "DESKTOP_NOT_CONFIGURED",
      message: "No signed AGSaaS desktop artifact is available.",
    },
    503,
    { "Cache-Control": "no-store" },
  ),
);
