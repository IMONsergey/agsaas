import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const apiQuery = mock(async () => []);
const workerQuery = mock(async () => []);
const providerHealth = mock(async (_provider: string) => true);
const aggregateHealth = mock(async () => {
  throw new Error("Per-provider probes must not check all integrations");
});

mock.module("@midday/db/client", () => ({
  db: { executeOnReplica: apiQuery },
}));
mock.module("@midday/db/worker-client", () => ({
  getWorkerDb: () => ({ execute: workerQuery }),
}));
mock.module("@midday/cache/health", () => ({
  checkHealth: async () => undefined,
}));
mock.module("@midday/banking", () => ({
  Provider: class {
    constructor(private params: { provider: string }) {}
    getProviderHealthCheck() {
      return providerHealth(this.params.provider);
    }
    getHealthCheck() {
      return aggregateHealth();
    }
  },
}));

// Require after registering the mocks; no production DB or network is touched.
const probes: typeof import("./probes") = require("./probes");

beforeEach(() => {
  apiQuery.mockClear();
  workerQuery.mockClear();
  providerHealth.mockClear();
  aggregateHealth.mockClear();
});

describe("database readiness", () => {
  test("API readiness uses the API database path", async () => {
    const database = probes
      .apiDependencies()
      .find((dep) => dep.name === "database");

    expect(await database?.probe()).toBe(true);
    expect(apiQuery).toHaveBeenCalledTimes(1);
    expect(workerQuery).not.toHaveBeenCalled();
  });

  test("worker readiness queries its worker pool, not the API pool", async () => {
    const database = probes
      .workerDependencies()
      .find((dep) => dep.name === "database");

    expect(await database?.probe()).toBe(true);
    expect(workerQuery).toHaveBeenCalledTimes(1);
    expect(apiQuery).not.toHaveBeenCalled();
  });
});

describe("banking readiness", () => {
  test.each([
    ["plaid", probes.plaidProbe],
    ["gocardless", probes.gocardlessProbe],
    ["enablebanking", probes.enableBankingProbe],
    ["teller", probes.tellerProbe],
  ] as const)("checks only %s once", async (provider, createProbe) => {
    expect(await createProbe().probe()).toBe(true);
    expect(providerHealth).toHaveBeenCalledTimes(1);
    expect(providerHealth).toHaveBeenCalledWith(provider);
    expect(aggregateHealth).not.toHaveBeenCalled();
  });

  test("reports a provider failure without rejecting the health response", async () => {
    providerHealth.mockRejectedValueOnce(new Error("provider unavailable"));

    expect(await probes.plaidProbe().probe()).toBe(false);
    expect(aggregateHealth).not.toHaveBeenCalled();
  });
});

describe("Supabase readiness transport", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    SUPABASE_INTERNAL_URL: process.env.SUPABASE_INTERNAL_URL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  };
  const fetcher = Object.assign(
    mock(
      async (
        _input: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1],
      ) => new Response("{}"),
    ),
    { preconnect: () => {} },
  );

  beforeEach(() => {
    fetcher.mockClear();
    globalThis.fetch = fetcher;
    delete process.env.SUPABASE_INTERNAL_URL;
    process.env.SUPABASE_URL = "http://localhost:3800";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://public.example.test";
    process.env.SUPABASE_SECRET_KEY = "fixture-secret-key";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
      "fixture-publishable-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("prefers the explicit private URL and keeps the API key and timeout", async () => {
    process.env.SUPABASE_INTERNAL_URL = "http://api-gw:8000";
    expect(await probes.supabaseProbe().probe()).toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://api-gw:8000/auth/v1/health");
    expect(new Headers(init?.headers).get("apikey")).toBe("fixture-secret-key");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("without an internal override, preserves the server public URL preference", async () => {
    expect(await probes.supabaseProbe().probe()).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://localhost:3800/auth/v1/health",
    );
  });

  test("handles trailing slashes and blank optional internal settings", async () => {
    process.env.SUPABASE_INTERNAL_URL = " http://api-gw:8000/ ";
    expect(await probes.supabaseProbe().probe()).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://api-gw:8000/auth/v1/health",
    );
    process.env.SUPABASE_INTERNAL_URL = " ";
    expect(await probes.supabaseProbe().probe()).toBe(true);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "http://localhost:3800/auth/v1/health",
    );
  });

  test("still supports the browser URL and publishable key fallback", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    expect(await probes.supabaseProbe().probe()).toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://public.example.test/auth/v1/health");
    expect(new Headers(init?.headers).get("apikey")).toBe(
      "fixture-publishable-key",
    );
  });

  test("reports a private gateway failure as unhealthy", async () => {
    process.env.SUPABASE_INTERNAL_URL = "http://api-gw:8000";
    fetcher.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    expect(await probes.supabaseProbe().probe()).toBe(false);
  });
});
