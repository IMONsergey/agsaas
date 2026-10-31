import { beforeEach, describe, expect, mock, test } from "bun:test";

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
