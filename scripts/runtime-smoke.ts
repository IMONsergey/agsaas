import assert from "node:assert/strict";

type Service = "api" | "worker";
type ReadinessBody = {
  status?: string;
  checks?: Record<string, { status?: string }>;
};

/** Require all real core probes, not merely HTTP 200 from a liveness endpoint. */
export function assertReadiness(
  body: ReadinessBody,
  service: Service,
  healthy: boolean,
) {
  assert.equal(
    body.status,
    healthy ? "ok" : "degraded",
    "Unexpected readiness status",
  );
  const required =
    service === "api"
      ? ["database", "redis_cache", "redis_queue", "supabase"]
      : ["database", "redis_queue", "supabase"];
  for (const name of required) {
    assert.equal(
      body.checks?.[name]?.status,
      !healthy && name === "supabase" ? "error" : "ok",
      `Unexpected ${name} readiness`,
    );
  }
}

export async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
) {
  const deadline = performance.now() + timeoutMs;
  do {
    if (await check()) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(intervalMs, remaining));
  } while (performance.now() <= deadline);
  throw new Error("Runtime assertion did not become true before its deadline");
}

async function request(path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:8080${path}`, {
    ...init,
    signal: AbortSignal.timeout(5_000),
  });
}

async function waitForReadiness(service: Service, healthy: boolean) {
  await pollUntil(async () => {
    try {
      const response = await request("/health/ready");
      if (response.status !== (healthy ? 200 : 503)) return false;
      const body = (await response.json()) as ReadinessBody;
      assertReadiness(body, service, healthy);
      return true;
    } catch {
      return false;
    }
  }, 60_000);
}

export async function smokeRuntime(service: Service) {
  // No arbitrary host flag: this script intentionally probes only its container.
  await waitForReadiness(service, true);
  const liveness = await request("/health");
  assert.equal(liveness.status, 200);
  assert.equal(((await liveness.json()) as { status: string }).status, "ok");

  if (service === "api") {
    assert.equal(
      (await request("/customers")).status,
      401,
      "Missing auth must not reach customer queries",
    );
    for (const platform of ["telegram", "whatsapp", "sendblue"]) {
      const response = await request(`/webhook/${platform}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(
        response.status,
        503,
        `${platform} must be explicitly unavailable without credentials`,
      );
    }
  } else {
    assert.equal((await request("/admin")).status, 404);
    assert.equal((await request("/info")).status, 404);
  }
  console.log(
    `${service}: HTTP liveness, core readiness and disabled-feature contracts passed`,
  );

  const fixtureUrl = "http://auth-health-fixture:8080/__test/";
  try {
    const disabled = await fetch(`${fixtureUrl}unavailable`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(disabled.status, 204);
    // The production probe caches for 30s. Exercise that contract without
    // test-only cache overrides or exposing an operational reset endpoint.
    await waitForReadiness(service, false);
    assert.equal(
      (await request("/health")).status,
      200,
      "A dependency outage must not turn liveness into readiness",
    );
  } finally {
    const restored = await fetch(`${fixtureUrl}available`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(restored.status, 204);
  }
  await waitForReadiness(service, true);
  console.log(
    `${service}: dependency-health failure and recovery passed (Supabase health transport fixture only)`,
  );
}

if (import.meta.main) {
  const service = Bun.argv[2];
  if ((service !== "api" && service !== "worker") || Bun.argv.length !== 3) {
    throw new Error("Usage: bun /tmp/agsaas-runtime-smoke.ts <api|worker>");
  }
  await smokeRuntime(service);
}
