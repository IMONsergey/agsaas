import { describe, expect, it } from "bun:test";
import type { Database } from "@midday/db/client";
import { withRetryOnPrimary } from "../utils/db-retry";

function createDatabases() {
  const primary = {} as Database;
  const replica = { usePrimaryOnly: () => primary } as unknown as Database;
  return { primary, replica };
}

describe("withRetryOnPrimary", () => {
  it("uses the replica when the first query succeeds", async () => {
    const { replica } = createDatabases();
    const queried: Database[] = [];
    const result = await withRetryOnPrimary(replica, async (db) => {
      queried.push(db);
      return { id: "customer-1" };
    });

    expect(result).toEqual({ id: "customer-1" });
    expect(queried).toEqual([replica]);
  });

  it("uses primary for a missing row only when requested", async () => {
    const { primary, replica } = createDatabases();
    const queried: Database[] = [];
    const result = await withRetryOnPrimary(
      replica,
      async (db) => {
        queried.push(db);
        return db === primary ? { id: "customer-1" } : null;
      },
      { retryOnNull: true },
    );

    expect(result).toEqual({ id: "customer-1" });
    expect(queried).toEqual([replica, primary]);
  });

  it("returns null when primary is unavailable", async () => {
    const replica = {} as Database;
    const result = await withRetryOnPrimary(replica, async () => null, {
      retryOnNull: true,
    });
    expect(result).toBeNull();
  });

  it("falls back to primary on a transient replica connection error", async () => {
    const { primary, replica } = createDatabases();
    const queried: Database[] = [];
    const result = await withRetryOnPrimary(replica, async (db) => {
      queried.push(db);
      if (db === replica) {
        throw new Error("CONNECTION timeout");
      }
      return "recovered";
    });

    expect(result).toBe("recovered");
    expect(queried).toEqual([replica, primary]);
  });

  it("does not hide a non-retryable query error", async () => {
    const { replica } = createDatabases();
    const failure = new Error("permission denied");
    let calls = 0;
    await expect(
      withRetryOnPrimary(replica, async () => {
        calls++;
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(calls).toBe(1);
  });

  it("retries primary at most maxRetries + 1 times", async () => {
    const { replica } = createDatabases();
    let primaryCalls = 0;
    const result = await withRetryOnPrimary(
      replica,
      async (db) => {
        if (db === replica) {
          throw new Error("replica connection lost");
        }
        primaryCalls++;
        if (primaryCalls === 1) {
          throw new Error("transient failure");
        }
        return "recovered";
      },
      { maxRetries: 1, baseDelay: 0 },
    );

    expect(result).toBe("recovered");
    expect(primaryCalls).toBe(2);
  });

  it("does not restart retries after a primary failure on the null path", async () => {
    const { primary, replica } = createDatabases();
    const failure = new Error("primary connection lost");
    let primaryCalls = 0;
    await expect(
      withRetryOnPrimary(
        replica,
        async (db) => {
          if (db === primary) {
            primaryCalls++;
            throw failure;
          }
          return null;
        },
        { retryOnNull: true, maxRetries: 1, baseDelay: 0 },
      ),
    ).rejects.toBe(failure);

    expect(primaryCalls).toBe(2);
  });
});
