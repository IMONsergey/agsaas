/**
 * Transport fixture ONLY. This is not Supabase, an authentication emulator,
 * application bootstrap SQL, or evidence that signup/RLS/storage works.
 */
if (process.env.AGSAAS_RUNTIME_TEST !== "1") {
  throw new Error(
    "This fixture may only run in the isolated runtime test stack",
  );
}

let available = true;
Bun.serve({
  hostname: "0.0.0.0",
  port: 8080,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/auth/v1/health") {
      return Response.json(
        { fixture: true, available },
        { status: available ? 200 : 503 },
      );
    }
    if (request.method === "POST" && path === "/__test/unavailable") {
      available = false;
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && path === "/__test/available") {
      available = true;
      return new Response(null, { status: 204 });
    }
    return new Response("Not implemented by the health-only test fixture", {
      status: 404,
    });
  },
});
