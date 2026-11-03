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
import { eq, inArray, sql } from "drizzle-orm";
import { getPlanLimits } from "../../../plans/src";
import type { Database } from "../client";
import {
  attachTeamConnector,
  getTeamEntitlements,
  markTeamConnectorDisconnecting,
  releaseTeamConnector,
  reserveGeneratedStorage,
  reserveTeamConnector,
} from "../queries/team-entitlements";
import {
  bankConnections,
  exportSnapshots,
  inbox,
  invoices,
  teams,
  users,
  usersOnTeam,
} from "../schema";
import { readTeamQuotaError } from "../team-quota-error";
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

describe.skipIf(!isTestDatabaseAvailable())(
  "atomic workspace entitlements (isolated PostgreSQL)",
  () => {
    let db: Database;
    let fixture: TenantIsolationFixture;
    let extraUsers: string[] = [];
    const team = () => fixture.own.teamId;
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      fixture = await createTenantIsolationFixture(db);
      extraUsers = [];
    });
    afterEach(async () => {
      if (fixture) {
        await db.execute(
          sql`delete from storage.objects where public.agsaas_storage_team(bucket_id,name) in (${fixture.own.teamId}::uuid,${fixture.other.teamId}::uuid)`,
        );
        await removeTenantIsolationFixture(db, fixture);
      }
      if (extraUsers.length)
        await db.delete(users).where(inArray(users.id, extraUsers));
    });
    afterAll(closeDatabase);
    const free = () =>
      db
        .update(teams)
        .set({
          plan: "trial",
          createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
        })
        .where(eq(teams.id, team()));
    async function assertQuota(
      operation: PromiseLike<unknown>,
      resource: string,
    ) {
      let error: unknown;
      try {
        await operation;
      } catch (caught) {
        error = caught;
      }
      expect(readTeamQuotaError(error)?.resource).toBe(resource);
    }
    async function assertSqlError(
      operation: PromiseLike<unknown>,
      message: string,
      code = "P0001",
    ) {
      let found: unknown;
      try {
        await operation;
      } catch (error) {
        found = error;
      }
      let current = found as
        | { code?: unknown; message?: unknown; cause?: unknown }
        | undefined;
      for (
        let depth = 0;
        depth < 8 && current && current.code !== code;
        depth++
      )
        current = current.cause as typeof current;
      expect(current?.code).toBe(code);
      expect(String(current?.message)).toContain(message);
    }
    async function newUser() {
      const id = randomUUID();
      extraUsers.push(id);
      await db
        .insert(users)
        .values({ id, teamId: team(), email: `${id}@quota.example.test` });
      return id;
    }
    function bank() {
      return {
        id: randomUUID(),
        teamId: team(),
        institutionId: randomUUID(),
        name: "Quota fixture",
        provider: "plaid" as const,
      };
    }
    async function object(
      size: number | null,
      path = `${team()}/${randomUUID()}.pdf`,
    ) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`,
        );
        await tx.execute(
          sql`insert into storage.objects(id,bucket_id,name,metadata) values(${randomUUID()}::uuid,'vault',${path},${JSON.stringify(size === null ? { mimetype: path.endsWith(".zip") ? "application/zip" : "application/pdf" } : { size, mimetype: path.endsWith(".zip") ? "application/zip" : "application/pdf" })}::jsonb)`,
        );
      });
    }
    test("SQL allocations exactly match the declared plan limits", async () => {
      for (const plan of ["free", "trial", "starter", "pro"]) {
        const value = (
          await db.execute<{ limits: unknown }>(
            sql`select public.agsaas_plan_limits(${plan}) as limits`,
          )
        ).rows[0]!.limits;
        expect(value).toEqual(getPlanLimits(plan));
      }
    });
    test("the final membership slot cannot be claimed concurrently twice", async () => {
      await db
        .update(teams)
        .set({ plan: "starter" })
        .where(eq(teams.id, team()));
      const ids = await Promise.all([newUser(), newUser()]);
      const results = await Promise.allSettled(
        ids.map((userId) =>
          db
            .insert(usersOnTeam)
            .values({ userId, teamId: team(), role: "member" }),
        ),
      );
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(
        1,
      );
      expect(results.filter((row) => row.status === "rejected")).toHaveLength(
        1,
      );
      expect((await getTeamEntitlements(db, team())).usage.users).toBe(2);
    });
    test("the final bank slot is atomic", async () => {
      await free();
      const results = await Promise.allSettled([
        db.insert(bankConnections).values(bank()),
        db.insert(bankConnections).values(bank()),
      ]);
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(
        1,
      );
      expect(
        (await getTeamEntitlements(db, team())).usage.bankConnections,
      ).toBe(1);
      await assertQuota(
        db.insert(bankConnections).values(bank()),
        "bankConnections",
      );
    });
    test("monthly Inbox use survives delete; a rolled back insertion and failed last slot consume nothing", async () => {
      await free();
      await db.insert(inbox).values(
        Array.from({ length: 49 }, () => ({
          id: randomUUID(),
          teamId: team(),
          fileName: "quota.pdf",
        })),
      );
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(inbox).values({
            id: randomUUID(),
            teamId: team(),
            fileName: "rollback.pdf",
          });
          throw new Error("fixture rollback");
        }),
      ).rejects.toThrow("fixture rollback");
      expect((await getTeamEntitlements(db, team())).usage.inbox).toBe(49);
      const ids = [randomUUID(), randomUUID()];
      const results = await Promise.allSettled(
        ids.map((id) =>
          db.insert(inbox).values({ id, teamId: team(), fileName: "last.pdf" }),
        ),
      );
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(
        1,
      );
      const index = results.findIndex((row) => row.status === "fulfilled");
      const id = ids[index]!;
      await db.delete(inbox).where(eq(inbox.id, id));
      expect((await getTeamEntitlements(db, team())).usage.inbox).toBe(50);
      await assertSqlError(
        db
          .insert(inbox)
          .values({ id, teamId: team(), fileName: "recreated.pdf" }),
        "cannot be recreated",
      );
      await assertQuota(
        db.insert(inbox).values({ id: randomUUID(), teamId: team() }),
        "inbox",
      );
    });
    test("invoices charge once on first issuance, including direct SQL; the sixth free issuance is denied", async () => {
      await free();
      await db
        .update(invoices)
        .set({ status: "unpaid" })
        .where(eq(invoices.id, fixture.own.invoiceId));
      await db
        .update(invoices)
        .set({ internalNote: "retry", status: "unpaid" })
        .where(eq(invoices.id, fixture.own.invoiceId));
      expect((await getTeamEntitlements(db, team())).usage.invoices).toBe(1);
      await db.insert(invoices).values(
        Array.from({ length: 3 }, () => ({
          id: randomUUID(),
          teamId: team(),
          status: "unpaid" as const,
          amount: 1,
          currency: "USD",
          token: randomUUID(),
        })),
      );
      const results = await Promise.allSettled(
        [0, 1].map(() =>
          db.insert(invoices).values({
            id: randomUUID(),
            teamId: team(),
            status: "unpaid",
            amount: 1,
            currency: "USD",
            token: randomUUID(),
          }),
        ),
      );
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(
        1,
      );
      expect((await getTeamEntitlements(db, team())).usage.invoices).toBe(5);
      expect(
        await db
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.teamId, team())),
      ).toHaveLength(5);
    });
    test("unknown and disconnecting connector reservations keep capacity until confirmed release", async () => {
      await free();
      const input = {
        teamId: team(),
        actorId: fixture.own.userId,
        toolkit: "github",
      };
      const [a, b] = await Promise.all([
        reserveTeamConnector(db, input),
        reserveTeamConnector(db, input),
      ]);
      expect(a.id).toBe(b.id);
      expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
      await reserveTeamConnector(db, { ...input, toolkit: "notion" });
      await assertQuota(
        reserveTeamConnector(db, { ...input, toolkit: "linear" }),
        "connectors",
      );
      await attachTeamConnector(db, {
        teamId: team(),
        id: a.id,
        providerAccountId: "ca_fixture",
      });
      await markTeamConnectorDisconnecting(db, {
        teamId: team(),
        providerAccountId: "ca_fixture",
      });
      await assertSqlError(
        db.execute(
          sql`update team_connector_reservations set status='unknown' where id=${a.id}::uuid`,
        ),
        "Disconnecting connector cannot be reactivated",
      );
      await expect(
        attachTeamConnector(db, {
          teamId: team(),
          id: a.id,
          providerAccountId: "ca_fixture",
        }),
      ).rejects.toThrow("no longer available");
      await assertQuota(
        reserveTeamConnector(db, { ...input, toolkit: "linear" }),
        "connectors",
      );
      await releaseTeamConnector(db, {
        teamId: team(),
        providerAccountId: "ca_fixture",
      });
      expect(
        (await reserveTeamConnector(db, { ...input, toolkit: "linear" }))
          .created,
      ).toBe(true);
      await expect(
        attachTeamConnector(db, {
          teamId: team(),
          id: a.id,
          providerAccountId: "ca_fixture",
        }),
      ).rejects.toThrow("no longer available");
    });
    test("trial expiry, downgrade and past-due block growth without deleting or blocking reads", async () => {
      expect((await getTeamEntitlements(db, team())).effectivePlan).toBe(
        "trial",
      );
      await db.insert(bankConnections).values([bank(), bank()]);
      await free();
      const value = await getTeamEntitlements(db, team());
      expect(value.effectivePlan).toBe("free");
      expect(value.usage.bankConnections).toBe(2);
      expect(value.limits.bankConnections).toBe(1);
      await assertQuota(
        db.insert(bankConnections).values(bank()),
        "bankConnections",
      );
      expect(
        await db
          .select()
          .from(bankConnections)
          .where(eq(bankConnections.teamId, team())),
      ).toHaveLength(2);
      await db
        .update(teams)
        .set({ plan: "pro", subscriptionStatus: "past_due" })
        .where(eq(teams.id, team()));
      await assertQuota(
        db.insert(inbox).values({ id: randomUUID(), teamId: team() }),
        "inbox",
      );
      await db
        .update(invoices)
        .set({ internalNote: "Existing document stays editable" })
        .where(eq(invoices.id, fixture.own.invoiceId));
      expect((await getTeamEntitlements(db, team())).usage.inbox).toBe(0);
    });
    test("authenticated SQL cannot create a self-assigned paid plan", async () => {
      await assertSqlError(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local role authenticated`);
          await tx.execute(
            sql`insert into teams(id,inbox_id,plan) values(${randomUUID()}::uuid,${randomUUID()},'pro')`,
          );
        }),
        "AGSAAS_ENTITLEMENT_WRITE_FORBIDDEN",
      );
      expect((await getTeamEntitlements(db, team())).effectivePlan).toBe(
        "trial",
      );
      await assertSqlError(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local role authenticated`);
          await tx.execute(
            sql`select public.reserve_generated_storage(${team()}::uuid,'forged','export',${randomUUID()}::uuid,1)`,
          );
        }),
        "permission denied",
        "42501",
      );
    });
    test("backdated Inbox timestamps cannot move current admission into an earlier month", async () => {
      await free();
      await db.insert(inbox).values({
        id: randomUUID(),
        teamId: team(),
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      expect((await getTeamEntitlements(db, team())).usage.inbox).toBe(1);
    });
    test("Storage preflight may roll back without size; committing unknown metadata is forbidden", async () => {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`,
        );
        await tx.execute(sql`savepoint upload_probe`);
        await tx.execute(
          sql`insert into storage.objects(id,bucket_id,name,metadata) values(${randomUUID()}::uuid,'vault',${`${team()}/${randomUUID()}.pdf`},'{"mimetype":"application/pdf"}'::jsonb)`,
        );
        await tx.execute(sql`rollback to savepoint upload_probe`);
      });
      await assertSqlError(object(null), "AGSAAS_QUOTA_METADATA_REQUIRED");
      expect((await getTeamEntitlements(db, team())).usage.storage).toBe(0);
    });
    test("final concurrent Storage writes count real metadata and cannot exceed the byte allowance", async () => {
      await free();
      const limit = 1024 ** 3;
      const chunk = 50 * 1024 ** 2;
      for (let i = 0; i < 20; i++) await object(chunk);
      await object(limit - 20 * chunk - 10);
      const results = await Promise.allSettled([object(10), object(10)]);
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(
        1,
      );
      expect((await getTeamEntitlements(db, team())).usage.storage).toBe(limit);
      await assertQuota(
        object(1, `${team()}/exports/${"a".repeat(64)}/${"b".repeat(64)}.zip`),
        "storage",
      );
      await assertSqlError(
        reserveGeneratedStorage(db, {
          teamId: team(),
          sourceKind: "export",
          sourceId: randomUUID(),
          path: `${team()}/exports/${"a".repeat(64)}/${"b".repeat(64)}.zip`,
          bytes: 1,
        }),
        "immutable snapshot",
      );
      const sourceId = randomUUID();
      const operationKey = "c".repeat(64);
      const path = `${team()}/exports/${operationKey}/${"d".repeat(64)}.zip`;
      await db.insert(exportSnapshots).values({
        id: sourceId,
        teamId: team(),
        operationKey,
        requestHash: "e".repeat(64),
        snapshotHash: "f".repeat(64),
        snapshot: {
          version: 1,
          teamId: team(),
          tables: {},
          asOf: "2026-11-03T00:00:00.000Z",
        },
      });
      await reserveGeneratedStorage(db, {
        teamId: team(),
        sourceKind: "export",
        sourceId,
        path,
        bytes: 3,
      });
      await assertQuota(object(2, path), "storage");
      await object(3, path);
      expect((await getTeamEntitlements(db, team())).usage.storage).toBe(
        limit + 3,
      );
      await assertQuota(object(1), "storage");
      await assertSqlError(
        reserveGeneratedStorage(db, {
          teamId: fixture.other.teamId,
          sourceKind: "export",
          sourceId,
          path,
          bytes: 3,
        }),
        "immutable snapshot",
      );
    });
  },
);
