import { expect, test } from "bun:test";
import { executeCustomerEnrichment } from "./customer-enrichment-operation";

const result = { verified: { description: "fixture" }, verifiedFieldCount: 1 };
test("cancellation aborts the transport and does not complete or fail a newer intent", async () => {
  let active = true,
    completed = 0,
    failed = 0,
    aborted = false;
  const run = executeCustomerEnrichment(
    {
      isCurrent: async () => active,
      enrich: (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      complete: async () => {
        completed++;
        return true;
      },
      fail: async () => {
        failed++;
      },
    },
    { pollMs: 5, timeoutMs: 1000 },
  );
  active = false;
  expect((await run).status).toBe("superseded");
  expect(aborted).toBe(true);
  expect(completed).toBe(0);
  expect(failed).toBe(0);
});
test("a late success after the deadline cannot apply fields", async () => {
  let completed = 0;
  const failures: string[] = [];
  const output = await executeCustomerEnrichment(
    {
      isCurrent: async () => true,
      enrich: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return result;
      },
      complete: async () => {
        completed++;
        return true;
      },
      fail: async (code) => {
        failures.push(code);
      },
    },
    { timeoutMs: 5, pollMs: 100 },
  );
  expect(output.status).toBe("failed");
  expect(completed).toBe(0);
  expect(failures).toEqual(["timeout"]);
});
test("the final database compare-and-set can reject a race after the last read", async () => {
  let attempted = 0,
    failed = 0;
  const output = await executeCustomerEnrichment({
    isCurrent: async () => true,
    enrich: async () => result,
    complete: async () => {
      attempted++;
      return false;
    },
    fail: async () => {
      failed++;
    },
  });
  expect(output.status).toBe("superseded");
  expect(attempted).toBe(1);
  expect(failed).toBe(0);
});
test("current successful operations report only confirmed application", async () => {
  const output = await executeCustomerEnrichment({
    isCurrent: async () => true,
    enrich: async () => result,
    complete: async (value) => value.verifiedFieldCount === 1,
    fail: async () => {
      throw new Error("unexpected failure");
    },
  });
  expect(output).toEqual({ status: "enriched", fieldsEnriched: 1 });
});
