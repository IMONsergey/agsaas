import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  cancelCustomerEnrichment,
  claimCustomerEnrichment,
  completeCustomerEnrichment,
  failCustomerEnrichment,
  isCustomerEnrichmentCurrent,
  listPendingCustomerEnrichments,
  requestCustomerEnrichment,
} from "../queries/customer-enrichment-operations";
import { customers, teams } from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "durable customer enrichment",
  () => {
    let db: Database;
    let identity: { customerId: string; teamId: string };
    beforeAll(async () => {
      db = getTestDatabase();
      const migration = await readFile(
        join(
          __dirname,
          "../../self-hosted/upgrades/supabase/migrations/20261103064000_customer_enrichment_operations.sql",
        ),
        "utf8",
      );
      await db.execute(sql.raw(migration));
    });
    beforeEach(async () => {
      identity = { customerId: randomUUID(), teamId: randomUUID() };
      await db.insert(teams).values({
        id: identity.teamId,
        name: "Enrichment fixture",
        inboxId: identity.teamId,
      });
      await db.insert(customers).values({
        id: identity.customerId,
        teamId: identity.teamId,
        name: "Fixture customer",
        email: "fixture@example.test",
        website: "https://example.test",
      });
    });
    afterEach(async () => {
      if (identity) await db.delete(teams).where(eq(teams.id, identity.teamId));
    });
    afterAll(closeDatabase);
    async function customer() {
      const [row] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, identity.customerId));
      return row!;
    }
    test("concurrent requests create one durable operation and one lease", async () => {
      const requests = await Promise.all([
        requestCustomerEnrichment(db, identity),
        requestCustomerEnrichment(db, identity),
      ]);
      expect(requests[0]!.operationId).toBe(requests[1]!.operationId);
      const claims = await Promise.all(
        requests.map((operation) => claimCustomerEnrichment(db, operation!)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await customer()).enrichmentStatus).toBe("processing");
    });
    test("Redis loss cannot erase the committed pending intent", async () => {
      const operation = (await requestCustomerEnrichment(db, identity))!;
      const pending = await listPendingCustomerEnrichments(db);
      expect(
        pending.some((row) => row.operationId === operation.operationId),
      ).toBe(true);
      expect((await customer()).enrichmentStatus).toBe("pending");
      // No queue call is needed to discover and dispatch this operation again.
      expect((await requestCustomerEnrichment(db, identity))!.operationId).toBe(
        operation.operationId,
      );
    });
    test("late completion after cancel cannot update any customer fields", async () => {
      const operation = (await requestCustomerEnrichment(db, identity))!;
      const lease = (await claimCustomerEnrichment(db, operation))!;
      expect(await cancelCustomerEnrichment(db, identity)).toBe(true);
      expect(await isCustomerEnrichmentCurrent(db, lease)).toBe(false);
      expect(
        await completeCustomerEnrichment(db, lease, {
          description: "late provider result",
          vatNumber: "LATE-VAT",
        }),
      ).toBe(false);
      expect((await customer()).description).toBeNull();
      expect((await customer()).vatNumber).toBeNull();
      expect((await customer()).enrichmentStatus).toBeNull();
    });
    test("an old attempt cannot overwrite a newer request or mark it failed", async () => {
      const first = (await requestCustomerEnrichment(db, identity))!;
      const oldLease = (await claimCustomerEnrichment(db, first))!;
      await cancelCustomerEnrichment(db, identity);
      const second = (await requestCustomerEnrichment(db, identity))!;
      expect(second.operationId).not.toBe(first.operationId);
      const newLease = (await claimCustomerEnrichment(db, second))!;
      expect(
        await completeCustomerEnrichment(db, oldLease, { description: "old" }),
      ).toBe(false);
      expect(await failCustomerEnrichment(db, oldLease, "provider_error")).toBe(
        false,
      );
      expect(
        await completeCustomerEnrichment(db, newLease, { description: "new" }),
      ).toBe(true);
      expect((await customer()).description).toBe("new");
    });
    test("expired leases are replaced and their late writes are fenced", async () => {
      const operation = (await requestCustomerEnrichment(db, identity))!;
      const oldLease = (await claimCustomerEnrichment(db, operation))!;
      await db.execute(
        sql`UPDATE public.customer_enrichment_operations SET lease_expires_at=now()-interval '1 second' WHERE id=${operation.operationId}::uuid`,
      );
      const next = (await claimCustomerEnrichment(db, operation))!;
      expect(next.attemptId).not.toBe(oldLease.attemptId);
      expect(next.attemptCount).toBe(2);
      expect(
        await completeCustomerEnrichment(db, oldLease, {
          description: "stale",
        }),
      ).toBe(false);
      expect(
        await completeCustomerEnrichment(db, next, { description: "fresh" }),
      ).toBe(true);
    });
    test("foreign team cannot request, cancel, claim or complete an operation", async () => {
      const operation = (await requestCustomerEnrichment(db, identity))!;
      const foreign = { ...identity, teamId: randomUUID() };
      expect(await requestCustomerEnrichment(db, foreign)).toBeNull();
      expect(await cancelCustomerEnrichment(db, foreign)).toBe(false);
      expect(
        await claimCustomerEnrichment(db, { ...operation, ...foreign }),
      ).toBeNull();
      const lease = (await claimCustomerEnrichment(db, operation))!;
      expect(
        await completeCustomerEnrichment(
          db,
          { ...lease, ...foreign },
          { description: "foreign" },
        ),
      ).toBe(false);
    });
    test("completion preserves manual billing edits made during the request", async () => {
      const operation = (await requestCustomerEnrichment(db, identity))!;
      const lease = (await claimCustomerEnrichment(db, operation))!;
      await db
        .update(customers)
        .set({ addressLine1: "Manual address", vatNumber: "MANUAL" })
        .where(eq(customers.id, identity.customerId));
      expect(
        await completeCustomerEnrichment(db, lease, {
          addressLine1: "Provider address",
          vatNumber: "PROVIDER",
          city: "Provider city",
        }),
      ).toBe(true);
      const row = await customer();
      expect(row.addressLine1).toBe("Manual address");
      expect(row.vatNumber).toBe("MANUAL");
      expect(row.city).toBe("Provider city");
    });
    test("provider configuration failure has a durable terminal state", async () => {
      const operation = (await requestCustomerEnrichment(db, identity))!;
      const lease = (await claimCustomerEnrichment(db, operation))!;
      expect(
        await failCustomerEnrichment(db, lease, "provider_not_configured"),
      ).toBe(true);
      expect((await customer()).enrichmentStatus).toBe("failed");
      expect(
        (await listPendingCustomerEnrichments(db)).some(
          (row) => row.operationId === operation.operationId,
        ),
      ).toBe(false);
      expect(
        (await requestCustomerEnrichment(db, identity))!.operationId,
      ).not.toBe(operation.operationId);
    });
  },
);
