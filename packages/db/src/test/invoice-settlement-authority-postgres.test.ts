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
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { financialRequestHash } from "../financial-job";
import { updateInvoiceWithIntent } from "../queries/invoice-commands";
import {
  getInvoiceSettlement,
  reconcileInvoiceSettlement,
  recordInvoiceSettlement,
} from "../queries/invoice-settlements";
import { listSecurityAuditEvents } from "../queries/security-audit";
import { invoices, users, usersOnTeam } from "../schema";
import {
  createTenantIsolationFixture,
  removeTenantIsolationFixture,
  type TenantIsolationFixture,
} from "./helpers/tenant-isolation-fixture";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe.skipIf(!isTestDatabaseAvailable())(
  "settlement ownership and atomic audit (isolated PostgreSQL)",
  () => {
    let db: Database;
    let fixture: TenantIsolationFixture;
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      fixture = await createTenantIsolationFixture(db);
    });
    afterEach(async () => {
      if (fixture) {
        await db.execute(
          sql`DELETE FROM public.security_audit_events WHERE team_id IN (${fixture.own.teamId}::uuid,${fixture.other.teamId}::uuid)`,
        );
        await removeTenantIsolationFixture(db, fixture);
      }
    });
    afterAll(closeDatabase);
    const scope = () => ({
      invoiceId: fixture.own.invoiceId,
      teamId: fixture.own.teamId,
    });
    function payment() {
      const id = randomUUID();
      return {
        ...scope(),
        operationKey: financialRequestHash(id),
        kind: "payment" as const,
        amountMinor: "4000",
        currency: "usd",
        provider: "manual" as const,
        providerAccountId: fixture.own.teamId,
        providerResourceId: id,
        actorId: fixture.own.userId,
        occurredAt: "2026-11-01T12:00:00.000Z",
        reason: "Private bank reference that must not enter security metadata",
      };
    }
    async function demoteOwner() {
      await db.insert(usersOnTeam).values({
        teamId: fixture.own.teamId,
        userId: fixture.other.userId,
        role: "owner",
      });
      await db
        .update(usersOnTeam)
        .set({ role: "member" })
        .where(
          and(
            eq(usersOnTeam.teamId, fixture.own.teamId),
            eq(usersOnTeam.userId, fixture.own.userId),
          ),
        );
    }
    async function currentInvoice() {
      return (
        await db
          .select()
          .from(invoices)
          .where(eq(invoices.id, fixture.own.invoiceId))
      )[0]!;
    }

    test("members and missing actors cannot use either manual money route", async () => {
      await demoteOwner();
      await expect(
        recordInvoiceSettlement(db, payment()),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        updateInvoiceWithIntent(db, {
          id: fixture.own.invoiceId,
          teamId: fixture.own.teamId,
          userId: fixture.own.userId,
          status: "paid",
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        updateInvoiceWithIntent(db, {
          id: fixture.own.invoiceId,
          teamId: fixture.own.teamId,
          status: "paid",
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(0);
      expect((await currentInvoice()).status).toBe("draft");
    });

    test("account deletion preparation also blocks manual settlement", async () => {
      await db
        .update(users)
        .set({ deletionStartedAt: new Date().toISOString() })
        .where(eq(users.id, fixture.own.userId));
      await expect(
        recordInvoiceSettlement(db, payment()),
      ).rejects.toMatchObject({ status: 403 });
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(0);
    });

    test("a concurrent demotion commits before the waiting command and denies its stale owner", async () => {
      await db.insert(usersOnTeam).values({
        teamId: fixture.own.teamId,
        userId: fixture.other.userId,
        role: "owner",
      });
      const ready = deferred<void>();
      const release = deferred<void>();
      const actorPid = deferred<number>();
      const blocker = db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM public.teams WHERE id=${fixture.own.teamId}::uuid FOR UPDATE`,
        );
        await tx
          .update(usersOnTeam)
          .set({ role: "member" })
          .where(
            and(
              eq(usersOnTeam.teamId, fixture.own.teamId),
              eq(usersOnTeam.userId, fixture.own.userId),
            ),
          );
        ready.resolve(undefined);
        await release.promise;
      });
      await Promise.race([
        ready.promise,
        blocker.then(() => {
          throw new Error("Demotion fixture ended before its barrier");
        }),
      ]);
      const operation = db
        .transaction(async (tx) => {
          actorPid.resolve(
            (
              await tx.execute<{ pid: number }>(
                sql`SELECT pg_backend_pid() AS pid`,
              )
            ).rows[0]!.pid,
          );
          return recordInvoiceSettlement(tx, payment());
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      try {
        const pid = await Promise.race([
          actorPid.promise,
          operation.then(() => {
            throw new Error(
              "Settlement finished before exposing its test connection",
            );
          }),
        ]);
        let observedWait = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const row = (
            await db.execute<{ waiting: boolean }>(
              sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND NOT granted) AS waiting`,
            )
          ).rows[0]!;
          if (row.waiting) {
            observedWait = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(observedWait).toBe(true);
      } finally {
        release.resolve(undefined);
        await blocker;
      }
      const outcome = await operation;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject({ status: 403 });
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(0);
    });

    test("an exact audit INSERT denial rolls back the journal, invoice and PDF intent", async () => {
      let failure: unknown;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`REVOKE INSERT ON public.security_audit_events FROM agsaas_app`,
          );
          await tx.execute(sql`SET LOCAL ROLE agsaas_app`);
          await recordInvoiceSettlement(tx, payment());
          throw new Error("Audit INSERT unexpectedly succeeded");
        });
      } catch (error) {
        failure = error;
      }
      let sqlFailure: { code?: unknown; message?: unknown } | undefined;
      for (
        let depth = 0;
        depth < 8 && failure && typeof failure === "object";
        depth++
      ) {
        const error = failure as {
          code?: unknown;
          message?: unknown;
          cause?: unknown;
        };
        if (error.code) {
          sqlFailure = error;
          break;
        }
        failure = error.cause;
      }
      expect(sqlFailure?.code).toBe("42501");
      expect(String(sqlFailure?.message)).toContain("security_audit_events");
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(0);
      expect(await currentInvoice()).toMatchObject({
        status: "draft",
        documentSnapshot: null,
        paidAt: null,
      });
      const intents = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM public.financial_job_dispatches WHERE team_id=${fixture.own.teamId}::uuid`,
      );
      expect(intents.rows[0]!.count).toBe(0);
    });

    test("ordinary backend privileges commit one redacted audit entry across replay", async () => {
      const input = payment();
      for (let attempt = 0; attempt < 2; attempt++) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE agsaas_app`);
          return recordInvoiceSettlement(tx, input);
        });
      }
      const audit = await listSecurityAuditEvents(db, {
        teamId: fixture.own.teamId,
      });
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        operation: "invoice.settlement.record",
        actorUserId: fixture.own.userId,
        targetId: fixture.own.invoiceId,
      });
      expect(audit.events[0]!.metadata).toEqual({
        provider: "manual",
        source: "payment",
        status: "unpaid",
      });
      expect(JSON.stringify(audit)).not.toContain(input.reason);
      expect((await getInvoiceSettlement(db, scope())).entries).toHaveLength(1);
    });

    test("projection repair requires a current owner and appends its audit atomically", async () => {
      await recordInvoiceSettlement(db, payment());
      await db.execute(
        sql`UPDATE public.invoice_settlement_state SET projection=jsonb_set(projection,'{balanceMinor}','"1"'::jsonb) WHERE invoice_id=${fixture.own.invoiceId}::uuid`,
      );
      await expect(
        reconcileInvoiceSettlement(db, { ...scope(), apply: true }),
      ).rejects.toMatchObject({ status: 403 });
      await demoteOwner();
      await expect(
        reconcileInvoiceSettlement(db, {
          ...scope(),
          apply: true,
          actorId: fixture.own.userId,
        }),
      ).rejects.toMatchObject({ status: 403 });
      const repaired = await reconcileInvoiceSettlement(db, {
        ...scope(),
        apply: true,
        actorId: fixture.other.userId,
      });
      expect(repaired.changed).toBe(true);
      expect(
        (await getInvoiceSettlement(db, scope())).projection?.balanceMinor,
      ).toBe("6000");
      const audit = await listSecurityAuditEvents(db, {
        teamId: fixture.own.teamId,
      });
      expect(audit.events.map((event) => event.operation)).toEqual([
        "invoice.settlement.reconcile",
        "invoice.settlement.record",
      ]);
    });
  },
);
